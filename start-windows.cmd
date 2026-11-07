@echo off
REM Starts the antigravity-zed-shim proxy on 127.0.0.1:8123.
REM Copy this file (or a shortcut to it) into shell:startup to launch at login.
cd /d "%~dp0"
if not exist dist\cli.js (
  echo Building shim for the first time...
  call npm run build
)
start "antigravity-zed-shim" /min node dist\cli.js serve --port 8123
echo Antigravity shim starting on http://127.0.0.1:8123
