@echo off
chcp 65001 >nul 2>&1
rem 可覆盖的环境变量：API_GATE_HOME（项目目录）、API_GATE_GIT（真实 git 绝对路径）
setlocal
set "GATE_HOME=%API_GATE_HOME%"
if "%GATE_HOME%"=="" set "GATE_HOME=C:\D\opt\api-gate"
set "REAL=%API_GATE_GIT%"
if "%REAL%"=="" set "REAL=C:\Program Files\Git\cmd\git.exe"
node "%GATE_HOME%\gate.mjs" --check "%CTI_BOT%|git %*"
if errorlevel 2 exit /b 2
"%REAL%" %*