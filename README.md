# api-gate

**给 AI agent 装的一道「外部操作闸门」：想碰 GitHub / 飞书？先查规矩。**

## 它解决什么问题

多 agent 系统里最常见的一种事故：agent 一拍脑袋就去调外部 API —— 没带 token、没走代理、不知道限流口径，然后被 403 / 限流 / SSL 错误打回来，再瞎试几轮，把额度烧光。

api-gate 的做法很土但很有效：**在命令这一层拦一下**。

- agent 要跑 `gh api ...` / `git push` / `lark-cli ...` 这类外部操作时，
- 如果**本次会话还没查过对应的接入规范** → 拦下（exit 2），并把该查什么告诉它；
- agent 查过规范 → 放行。

一句话：**不是不让你做，是要你先知道怎么做。**

## 工作原理

```
agent 敲 gh api user
      ↓
PATH 最前面的 api-gate/bin/gh  （包装脚本）
      ↓
node gate.mjs --check "<bot>|gh api user"   命中闸门?
      ↓ 命中且本会话未查规范             ↓ 否则
exit 2 + 提示"先查规范"               exec 真实 gh.exe
```

- **规则是命令式匹配**（锚定命令位置的正则），不是字符串包含 —— 避免 `echo "git push"` 这种误伤。
- **状态按会话落盘**（`%TEMP%/api-gate-state/<session>.json`），因为 CLI hook 是短进程，记不住内存。
- **安全阀**：每个会话、每个域**只拦一次**。第二次无条件放行 —— 闸门卡死比漏拦危害大得多。

## 两种接入形态

### 1. PATH 包装（适合任何能跑 shell 的 agent）

把 `bin/` 放到 PATH **最前面**，让 `gh` / `git` / `lark-cli` 先撞到包装脚本。

```sh
# 包装脚本需要知道真实命令在哪（见下方配置），然后：
export PATH="/path/to/api-gate/bin:$PATH"
export CTI_BOT="my-bot"     # 身份标识，写进提示语与状态文件
```

Windows 上同时提供 `.cmd` 与无扩展名 sh 两份：cmd 环境跑 `.cmd`，Git Bash 不解析 `.cmd`，跑无扩展名那份。

> ⚠️ 两份脚本对「自己住哪儿」的处理不同：
> **sh 版**会按自身位置自动定位 `gate.mjs`（Git Bash 的 `/c/...` 路径需经 `cygpath` 转成 Windows 风格才能喂给 `node.exe` —— 脚本里已处理）；
> **`.cmd` 版**默认写死作者本机的绝对路径。**换机器时 `.cmd` 必须设 `API_GATE_HOME`**。

### 2. CLI 的 PreToolUse hook（claude-code / codex 等）

`gate.mjs` 本身就是个 hook 脚本：stdin 收一行 JSON（`hook_event_name` / `tool_name` / `tool_input` / `session_id`），
**exit 2 + stderr 写理由 = 拦下**，exit 0 = 放行。

```jsonc
// ~/.claude/settings.json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /path/to/api-gate/gate.mjs" }] }]
  }
}
```

## 配置

全部走环境变量，默认值针对作者本机；**换机器必须改**。

| 变量 | 作用 | 默认 |
|---|---|---|
| `CTI_BOT` | 调用方 bot 名（身份标识） | `cli` |
| `API_GATE_GH` | 真实 `gh` 可执行文件路径 | `/c/Program Files/GitHub CLI/gh.exe` |
| `API_GATE_GIT` | 真实 `git` 路径 | `/c/Program Files/Git/cmd/git.exe` |
| `API_GATE_LARK` | 真实 `lark-cli` 路径 | `/c/Users/<you>/AppData/Roaming/npm/lark-cli` |
| `API_GATE_STATE_DIR` | 状态文件目录 | `<系统临时目录>/api-gate-state` |
| `API_GATE_PRESET_GITHUB` | 提示里让 agent 去查的「成品答案」名 | `GitHub 访问通道` |
| `API_GATE_PRESET_LARK` | 同上（飞书） | `飞书操作规范` |

> `API_GATE_PRESET_*` 指向的是「agent 该去哪儿查规范」。
> 默认值配的是作者本机的 openmem 记忆中枢（`mh_tool(name="...")`）；你没有 openmem 时，
> 改成你自己的文档 / wiki 入口名即可 —— 闸门只负责把这句话甩给 agent。

真实命令路径**必须写绝对路径**，不能写命令名 —— 否则包装脚本会转发给自己，无限递归。

## 当前规则

| 域 | 命中条件 |
|---|---|
| GitHub | `gh api/release/repo/pr/issue/run/auth`、`git push/clone/fetch/pull/ls-remote`、`curl`/`wget` 且命令行含 github 域名 |
| 飞书 | `lark-cli ...`、原生工具名 `lark_send_*` / `lark_reply_*` |

加域 = 在 `gate.mjs` 的 `DOMAINS` 数组里加一项（`keywords` / `cmdHit` / `toolHit`）。

## 实测

在 12 个 nssm 常驻 agent 上逐个验证过拦截与放行（含 hermes 的 shell 探针挂死修复、zcode 的模型切换）。
拦截日志留痕：`%TEMP%/api-gate-calls.log`。

## 局限

- **只拦得住被包装的命令**。绕开 PATH 走绝对路径调 `gh.exe` 就拦不到 —— 这是"提高门槛"，不是"安全边界"。
- **只拦一次**（安全阀）。别指望它当一个严格的权限系统。
- 提示语里指向的规范来源是可配置的，本项目**不包含**任何规范内容本身。

## License

MIT
