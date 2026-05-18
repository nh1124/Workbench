@echo off
setlocal

echo ============================================================
echo   LBS (Load Balancing System) - System Initializer
echo ============================================================
echo.
echo This script will PERFORM A CLEAN RESET of the LBS system:
echo 1. Stop all LBS containers.
echo 2. REMOVE ALL DATABASE VOLUMES (Wiping all data).
echo 3. Rebuild images and start the system fresh.
echo.
pause

echo.
echo [1/3] Resetting environment...
docker-compose down -v --remove-orphans

echo.
echo [2/3] Building and starting system (Clean Slate)...
docker-compose up --build -d

echo.
echo ============================================================
echo   LBS INITIALIZATION COMPLETE
echo ============================================================
echo.
echo Access the LBS UI ^& API:
echo - UI: http://localhost:8100
echo - API Docs: http://localhost:8100/docs
echo.
echo Recommended Testing Flow:
echo 1. Open the UI.
echo 2. Click "Need an account? Create one now" to register locally.
echo 3. Log in with your new local credentials.
echo 4. Go to Settings to test External Identity linking or API Keys.
echo.
echo ============================================================
pause
