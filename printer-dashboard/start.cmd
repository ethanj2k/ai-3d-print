@echo off
cd /d "%~dp0"
start "" http://127.0.0.1:3470
wscript "%~dp0run-hidden.vbs"
