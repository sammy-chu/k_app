@echo off
echo ========================================
echo      K-Line App Start Script
echo ========================================
echo.

REM Try to detect Trae-provided Node.js if system Node.js is missing
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] System Node.js not found, checking for Trae Node.js...
    if exist "%USERPROFILE%\.trae\sdks\versions\node\current\node.exe" (
        echo [INFO] Found Trae-provided Node.js.
        echo [INFO] Setting PATH...
        set "PATH=%USERPROFILE%\.trae\sdks\versions\node\current;%PATH%"
    ) else (
        echo [INFO] Trae-provided Node.js not found.
    )
) else (
    echo [INFO] System Node.js detected.
)

echo [INFO] Checking Node.js version...
node --version
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo [INFO] Please install it from https://nodejs.org/
    pause
    exit /b 1
)

echo [INFO] Checking npm version...
call npm --version
if %errorlevel% neq 0 (
    echo [ERROR] npm is not available. Please check your Node.js installation.
    pause
    exit /b 1
)

REM Check if node_modules exists
if not exist "node_modules" (
    echo [WARNING] Dependencies not found. Installing automatically...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install dependencies. Please run 'npm install' manually.
        pause
        exit /b 1
    )
)

echo [INFO] Starting the application...
echo [INFO] Press Ctrl+C to stop the server.
call npm run start

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Application exited with error code %errorlevel%
    pause
)
