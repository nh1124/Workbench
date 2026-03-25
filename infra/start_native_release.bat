@echo off
set "PROJECT_ROOT=%~dp0.."
echo Starting Workbench (release build)...
start "" "%PROJECT_ROOT%\native\desktop\src-tauri\target\release\Workbench Native.exe"
