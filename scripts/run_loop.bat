@echo off
setlocal
cd /d "%~dp0.."

if not exist logs mkdir logs

:: Use the specific node path detected in the environment
set "NODE_EXE=C:\Users\sami\.trae\binaries\node\versions\22.20.0\node.exe"

:: If that specific path doesn't exist, try fallback
if not exist "%NODE_EXE%" (
    echo [%date% %time%] Warning: Specific node path not found, trying system node... >> logs\monitor.log
    set NODE_EXE=node
)

:loop
echo [%date% %time%] Application starting... >> logs\monitor.log

:: Run the application directly with the absolute path to node
"%NODE_EXE%" src/server.js >> logs\app.log 2>&1

echo [%date% %time%] Application stopped (exit code %errorlevel%). Restarting in 10 seconds... >> logs\monitor.log
timeout /t 10 /nobreak >nul
goto loop
