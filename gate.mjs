#!/usr/bin/env node
/**
 * api-gate —— 通用「外部操作闸门」hook 脚本
 *
 * 用途：作为 claude-code / codex 等 CLI 的 PreToolUse hook（命令行方式配置）。
 *   claude-code: ~/.claude/settings.json → hooks.PreToolUse
 *   codex:       ~/.codex/hooks.json     → hooks.PreToolUse
 *
 * 协议（两家通用）：
 *   - 输入：stdin 一行 JSON，含 hook_event_name / tool_name / tool_input / session_id
 *   - 拦下：exit code 2，理由写 stderr（两家都支持；claude 另支持 stdout JSON，不必用）
 *   - 放行：exit 0
 *
 * 规则与 DSH 插件 @oadank/dsh-api-gate 一致（命令式匹配，避免字符串误伤）：
 *   GitHub 域：gh api|release|repo|pr|issue / git push|clone|fetch|pull|ls-remote / curl+github
 *   飞书域：  lark-cli 调用 / lark_send_* 原生发消息工具
 *   解除：本会话调用过 openmem 记忆工具（mh_*）且内容谈到该域 → 按 session 落标记文件
 *   安全阀：每 session 每域只拦 1 次
 *
 * 状态文件：%TEMP%/api-gate-state/<session>.json（hook 是短进程，必须落盘记状态）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE_DIR = process.env.API_GATE_STATE_DIR
  || path.join(os.tmpdir(), 'api-gate-state')

// ---------- 可配置项（换机器改环境变量，或改这里的默认值） ----------
// 提示里让 agent 去哪儿查规范；{preset} 会替换成下方 DOMAINS 里的 preset 名
const LOOKUP_TPL = process.env.API_GATE_LOOKUP
  || 'openmem mh_tool(name="{preset}")'
const PRESET_GITHUB = process.env.API_GATE_PRESET_GITHUB || 'GitHub 访问通道'
const PRESET_LARK = process.env.API_GATE_PRESET_LARK || '飞书操作规范'

// ---------- 匹配规则（与 DSH 插件同源，命令式锚定） ----------
const RE_GH_HOST = /github\.com|api\.github|githubusercontent/i
const RE_GH_CMD = /(?:^|[;&|])\s*gh\s+(?:api|release|repo|pr|issue|run|auth)\b/i
const RE_GIT_OUTBOUND = /(?:^|[;&|])\s*git\b[^\n;&|]*\b(?:push|clone|fetch|pull|ls-remote)\b/i
const RE_NET_CMD = /(?:^|[;&|])\s*(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b/i
const RE_LARK_CLI = /(?:^|[;&|])\s*(?:(?:npx|pnpm|yarn|bunx)\s+)?(?:\S*[\\/])?lark-cli\b/i
const RE_LARK_SEND_TOOL = /^lark_(send|reply)/i

const DOMAINS = [
  {
    id: 'github',
    label: 'GitHub',
    preset: 'GitHub 访问通道',
    keywords: /github|git\b|gh\s|token|凭据/i,
    cmdHit: (cmd) =>
      RE_GH_CMD.test(cmd) ||
      RE_GIT_OUTBOUND.test(cmd) ||
      (RE_NET_CMD.test(cmd) && RE_GH_HOST.test(cmd)),
    toolHit: () => false,
  },
  {
    id: 'lark',
    label: '飞书',
    preset: PRESET_LARK,
    keywords: /飞书|lark|feishu|消息|群|chat|bot/i,
    cmdHit: (cmd) => RE_LARK_CLI.test(cmd),
    toolHit: (toolName) => RE_LARK_SEND_TOOL.test(toolName),
  },
]

// ---------- 状态（短进程，落盘） ----------
function statePath(session) {
  const safe = String(session || 'nosession').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
  return path.join(STATE_DIR, `${safe}.json`)
}

function loadState(session) {
  try {
    return JSON.parse(fs.readFileSync(statePath(session), 'utf8'))
  } catch {
    return { passed: [], denials: {} }
  }
}

function saveState(session, state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(statePath(session), JSON.stringify(state), 'utf8')
  } catch {
    /* 状态写不了也不阻断（宁可漏拦，不可卡死） */
  }
}

function reasonFor(domain) {
  return [
    ` 拦下：这是${domain.label}操作，但本会话你还没查过对应的通道/规范就动手了。`,
    '先查规范（取到内容后再重试本次操作）：',
    '  ' + LOOKUP_TPL.split('{preset}').join(domain.preset),
    '（本会话这个闸门只拦一次；查过即放行。看拦了什么：%TEMP%/api-gate-calls.log）',
  ].join('\n')
}

// ---------- 取工具调用的命令文本 ----------
function commandOf(toolName, toolInput) {
  if (!toolInput) return ''
  if (typeof toolInput === 'string') return toolInput
  // claude/codex 的 shell 工具把命令放在 command 里
  if (typeof toolInput.command === 'string') return toolInput.command
  if (typeof toolInput.cmd === 'string') return toolInput.cmd
  // 其它形态：整体 JSON 化后匹配
  try {
    return JSON.stringify(toolInput)
  } catch {
    return ''
  }
}

function handle(payload) {
  const session = payload.session_id || payload.sessionId || 'nosession'
  const toolName = payload.tool_name || payload.toolName || ''
  // 调用留痕（排查 hook 到底有没有被 CLI 调用）
  try {
    fs.appendFileSync(
      path.join(os.tmpdir(), 'api-gate-calls.log'),
      `${new Date().toISOString()} ev=${payload.hook_event_name || '?'} tool=${toolName} cmd=${commandOf(toolName, payload.tool_input).slice(0, 100)}\n`,
      'utf8',
    )
  } catch {
    /* 留痕失败不影响判定 */
  }
  const state = loadState(session)
  const passed = new Set(state.passed || [])
  state.denials = state.denials || {}

  // ① openmem 记忆工具调用 → 按关键词解除对应域
  if (/^mcp__openmem__mh_|^mh_/i.test(toolName)) {
    const text = commandOf(toolName, payload.tool_input)
    for (const d of DOMAINS) {
      if (d.keywords.test(text)) passed.add(d.id)
    }
    state.passed = [...passed]
    saveState(session, state)
    return null
  }

  const cmd = commandOf(toolName, payload.tool_input)

  // ② 逐域判定
  for (const d of DOMAINS) {
    const hit = d.toolHit(toolName) || d.cmdHit(cmd)
    if (!hit) continue
    if (passed.has(d.id)) continue
    const n = (state.denials[d.id] || 0) + 1
    state.denials[d.id] = n
    if (n > 1) {
      passed.add(d.id) // 安全阀：每域只拦一次
      state.passed = [...passed]
      saveState(session, state)
      continue
    }
    saveState(session, state)
    return reasonFor(d)
  }

  saveState(session, state)
  return null
}

// ---------- 命令行检查模式（给 PATH 包装脚本用） ----------
// 用法：node gate.mjs --check "<完整命令行>"   → exit 2=拦下（stderr 为理由）/ exit 0=放行
// 状态：CLI 场景没有 session 概念（每条命令新进程），改用「同域 5 分钟内只拦一次」的时间窗防死循环。
function checkCommandLine(cmd, bot) {
  for (const d of DOMAINS) {
    if (!d.cmdHit(cmd)) continue
    const stampFile = path.join(STATE_DIR, `cli-${bot}-${d.id}.stamp`)
    try {
      const last = Number(fs.readFileSync(stampFile, 'utf8'))
      if (Number.isFinite(last) && Date.now() - last < 5 * 60 * 1000) return null // 刚拦过 → 放行
    } catch {
      /* 无记录 → 继续判定 */
    }
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      fs.writeFileSync(stampFile, String(Date.now()), 'utf8')
    } catch {
      /* 状态写不了也不阻断 */
    }
    return reasonFor(d)
  }
  return null
}

// ---------- 入口 ----------
const argv = process.argv.slice(2)
if (argv[0] === '--check') {
  const rawArg = argv[1] ?? ''
  const sepIdx = rawArg.indexOf('|')
  const bot = sepIdx > 0 ? rawArg.slice(0, sepIdx) : 'cli'
  const cmd = sepIdx > 0 ? rawArg.slice(sepIdx + 1) : rawArg
  try {
    const reason = checkCommandLine(cmd, bot)
    if (reason) {
      process.stderr.write(reason + '\n')
      process.exit(2)
    }
  } catch (e) {
    // 诊断友好：放行但不再静默（静默 catch 会掩盖真实问题）
    process.stderr.write('[api-gate] check 异常，已放行: ' + (e && e.message ? e.message : String(e)) + '\n')
  }
  process.exit(0)
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  let payload = {}
  try {
    payload = JSON.parse(raw || '{}')
  } catch {
    process.exit(0) // 解析不了就放行，绝不卡死
  }
  try {
    // 只处理工具执行前；其它事件直接放行
    const ev = payload.hook_event_name || payload.hookEventName || ''
    if (ev && ev !== 'PreToolUse') process.exit(0)

    const reason = handle(payload)
    if (reason) {
      process.stderr.write(reason)
      process.exit(2) // deny
    }
    process.exit(0)
  } catch {
    process.exit(0) // 任何异常都不阻断工具执行
  }
})
// 没有 stdin 时（被直接调用）不要挂住
setTimeout(() => process.exit(0), 10000).unref?.()