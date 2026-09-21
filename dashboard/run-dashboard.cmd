@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem The dashboard needs Node 22+ for node:sqlite, and the Node on PATH is often
rem older than one installed elsewhere. Test candidates by version rather than
rem trusting a path, so this works on a machine we know nothing about.
set "NODE="
for %%N in (
  "node"
  "C:\Program Files\nodejs\node.exe"
  "C:\tools\node24\node.exe"
  "%LOCALAPPDATA%\nvs\default\node.exe"
  "%ProgramFiles%\nodejs\node.exe"
  "%LOCALAPPDATA%\Programs\nodejs\node.exe"
) do (
  if not defined NODE (
    for /f "tokens=1 delims=." %%V in ('%%N --version 2^>nul') do (
      set "MAJOR=%%V"
      set "MAJOR=!MAJOR:v=!"
      if !MAJOR! GEQ 22 set "NODE=%%~N"
    )
  )
)

if not defined NODE (
  echo.
  echo   No Node 22+ found. The dashboard stores its data with node:sqlite,
  echo   which arrived in Node 22. Install a newer Node, or add its path to
  echo   the candidate list at the top of this file.
  echo.
  pause
  exit /b 1
)

echo Using !NODE!
:loop
"!NODE!" server.js
timeout /t 2 /nobreak >nul
goto loop
