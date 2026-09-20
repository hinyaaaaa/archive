@echo off
chcp 65001 > nul
start "" "D:\Ankel\ollama\ollama.exe" serve
timeout /t 3 /nobreak > nul
start "" powershell -NoExit -Command "cd D:\Ankel\server; node --max-old-space-size=4096 server.js"
timeout /t 3 /nobreak > nul
start "" "http://localhost:3000"
