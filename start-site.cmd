@echo off
cd /d "%~dp0"
if exist "%~dp0.node\node.exe" set "PATH=%~dp0.node;%PATH%"
call npm run dev -- --open
pause
