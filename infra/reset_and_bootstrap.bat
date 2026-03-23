@echo off
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "PROJECT_ROOT=%SCRIPT_DIR%\.."

call "%SCRIPT_DIR%\initialize_system.bat"
if errorlevel 1 exit /b 1

echo.
echo [WARN] This will DELETE all Workbench DB data (docker volumes).
set /p WB_CONFIRM=Type YES to continue: 
if /i not "%WB_CONFIRM%"=="YES" (
  echo [CANCELLED] Initialization aborted.
  exit /b 1
)

set /p WB_USERNAME=Workbench username for re-initialization: 
set /p WB_PASSWORD=Workbench password for re-initialization: 
if "%WB_USERNAME%"=="" (
  echo [ERROR] Username is required.
  exit /b 1
)
if "%WB_PASSWORD%"=="" (
  echo [ERROR] Password is required.
  exit /b 1
)

echo.
echo [1/5] Resetting databases (docker compose down -v)...
cd /d "%PROJECT_ROOT%"
docker compose down -v --remove-orphans
if errorlevel 1 (
  echo [ERROR] Failed to reset docker volumes.
  exit /b 1
)

echo [2/5] Starting databases...
docker compose up -d
if errorlevel 1 (
  echo [ERROR] Failed to start docker containers.
  exit /b 1
)

echo [3/5] Starting backend services (Core HTTP + internal services) in a new terminal...
start "Workbench Backend Services" cmd /k "cd /d \"%PROJECT_ROOT%\" && npm run dev:services"

echo [4/5] Waiting for Workbench Core (http://127.0.0.1:4100/health)...
powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 90;$i++){ try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:4100/health; if($r.StatusCode -eq 200){ $ok=$true; break } } catch {}; Start-Sleep -Seconds 1 }; if(-not $ok){ exit 1 }"
if errorlevel 1 (
  echo [ERROR] Workbench Core did not become healthy in time.
  echo [HINT] Check the "Workbench Backend Services" terminal logs (Core + internal services).
  exit /b 1
)

echo [5/5] Registering account and provisioning all services...
set "WB_USERNAME=%WB_USERNAME%"
set "WB_PASSWORD=%WB_PASSWORD%"
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $body=@{ username=$env:WB_USERNAME; password=$env:WB_PASSWORD } | ConvertTo-Json; $res=Invoke-RestMethod -UseBasicParsing -Method Post -Uri 'http://127.0.0.1:4100/accounts/register' -ContentType 'application/json' -Body $body; Write-Host ('[OK] user=' + $res.user.username); if($res.provisioning){ foreach($p in $res.provisioning){ $msg='  - ' + $p.serviceId + ': ' + $p.status; if($p.message){ $msg = $msg + ' (' + $p.message + ')' }; Write-Host $msg } }"
if errorlevel 1 (
  echo [ERROR] Account registration/provisioning failed.
  echo [HINT] If account already exists, run login from UI or reset again.
  exit /b 1
)

echo.
echo [DONE] System reset and bootstrap completed.
echo Next:
echo   1. Keep the "Workbench Backend Services" terminal running.
echo   2. Start native UI:  .\infra\start_native.bat
echo   3. In Settings ^> Account, sign in with the same credentials once.

endlocal

