@echo off
cd /d "%~dp0"
set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
:loop
"%NODE%" server.js
timeout /t 2 /nobreak >nul
goto loop
