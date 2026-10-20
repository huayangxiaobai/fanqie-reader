@echo off
rem Launch Fanqie Mini Reader (fanqie-reader)
cd /d "%~dp0"
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo Electron runtime not found. Please run: npm install
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." --no-sandbox --disable-gpu %*
