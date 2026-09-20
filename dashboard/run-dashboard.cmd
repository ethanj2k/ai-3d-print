@echo off
cd /d "%~dp0"

rem node:sqlite needs Node 22+. "C:\Program Files\nodejs" is still on 20 here,
rem so prefer a known-newer build and fall back to whatever is on PATH.
set "NODE="
for %%N in (
  "C:\tools\node24\node.exe"
  "%LOCALAPPDATA%\nvs\default\node.exe"
  "C:\Program Files\nodejs\node.exe"
) do if not defined NODE if exist %%N set "NODE=%%~N"
if not defined NODE set "NODE=node"

:loop
"%NODE%" server.js
timeout /t 2 /nobreak >nul
goto loop
