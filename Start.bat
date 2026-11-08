@echo off
cd /d "%~dp0"
start "" http://127.0.0.1:8020
node server.js
pause
