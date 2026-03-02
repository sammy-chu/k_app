@echo off
setlocal
cd /d "%~dp0"

set "SHORTCUT_NAME=K_App_AutoStart.lnk"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_DIR%\%SHORTCUT_NAME%"

echo ==========================================
echo        K App Auto-Start Removal
echo ==========================================
echo.
echo Startup Shortcut: %SHORTCUT_PATH%
echo.

if exist "%SHORTCUT_PATH%" (
    del "%SHORTCUT_PATH%"
    if not exist "%SHORTCUT_PATH%" (
        echo [SUCCESS] Auto-start shortcut removed successfully!
        echo The application will NO LONGER start automatically on login.
    ) else (
        echo [ERROR] Failed to remove shortcut. Please try running as Administrator.
    )
) else (
    echo [INFO] Auto-start shortcut not found. It might have been already removed.
)

echo.
pause
