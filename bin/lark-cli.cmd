@echo off
chcp 65001 >nul 2>&1
rem 可覆盖的环境变量：API_GATE_HOME（项目目录）、API_GATE_LARK（真实 lark-cli 绝对路径）
setlocal
set "GATE_HOME=%API_GATE_HOME%"
if "%GATE_HOME%"=="" set "GATE_HOME=C:\D\opt\api-gate"
set "REAL=%API_GATE_LARK%"
if "%REAL%"=="" set "REAL=%APPDATA%\npm\lark-cli.cmd"
node "%GATE_HOME%\gate.mjs" --check "%CTI_BOT%|lark-cli %*"
if errorlevel 2 exit /b 2
"%REAL%" %*