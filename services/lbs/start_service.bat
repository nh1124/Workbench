@echo off
setlocal

cd /d "%~dp0"

if not exist ".env" if exist ".env.example" (
  copy ".env.example" ".env" >nul
  echo [LBS] Created .env from .env.example
)

where node >nul 2>nul
if errorlevel 1 (
  echo [LBS] Node.js is required to prepare and launch the embedded LBS service.
  exit /b 1
)

echo [LBS] Starting LBS service...
node scripts\lbs-python.mjs -m src.main
exit /b %ERRORLEVEL%
