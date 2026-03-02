@echo off
setlocal
cd /d "%~dp0"

set "VBS_SCRIPT=%CD%\scripts\start_background.vbs"
set "SHORTCUT_NAME=K_App_AutoStart.lnk"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_DIR%\%SHORTCUT_NAME%"

echo ==========================================
echo        K App Auto-Start Setup
echo ==========================================
echo.
echo Target Script: %VBS_SCRIPT%
echo Startup Dir:   %STARTUP_DIR%
echo.

if not exist "%VBS_SCRIPT%" (
    echo [ERROR] Could not find the background script at:
    echo %VBS_SCRIPT%
    echo Please make sure you are running this script from the project root.
    pause
    exit /b 1
)

echo Creating startup shortcut...

powershell -Command "$WS = New-Object -ComObject WScript.Shell; $SC = $WS.CreateShortcut('%SHORTCUT_PATH%'); $SC.TargetPath = '%VBS_SCRIPT%'; $SC.WorkingDirectory = '%CD%\scripts'; $SC.Description = 'K App AutoStart'; $SC.Save()"

if exist "%SHORTCUT_PATH%" (
    echo.
    echo [SUCCESS] Startup shortcut created successfully!
    echo The application will now start automatically when you log in.
    echo.
    echo To start it immediately without rebooting, double-click:
    echo scripts\start_background.vbs
) else (
    echo.
    echo [ERROR] Failed to create shortcut.
)
echo.
pause
