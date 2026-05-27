@echo off
echo ========================================
echo      K-Line App Dev Start Script
echo ========================================
echo.

REM Try to detect Trae-provided Node.js if system Node.js is missing
node --version >nul 2>&1
if %errorlevel% neq 0 (
    if exist "%USERPROFILE%\.trae\sdks\versions\node\current\node.exe" (
        echo [INFO] Using Trae-provided Node.js...
        set "PATH=%USERPROFILE%\.trae\sdks\versions\node\current;%PATH%"
    )
)

REM Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed. Please install it from https://nodejs.org/
    pause
    exit /b 1
)

REM Check if npm is available
npm --version >nul 2>&1
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

echo [INFO] Starting the application in development mode...
npm run dev

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Application exited with error code %errorlevel%
    pause
)
