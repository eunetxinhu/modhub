@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js nao encontrado. Instale em https://nodejs.org && pause && exit /b 1)
start "Twitch Mod Hub" /min node server.js
