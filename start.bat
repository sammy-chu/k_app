@echo off

echo ============================================
echo          K-Alert System Startup
echo ============================================
echo.

echo Node version:
node -v
echo.

echo npm version:
npm -v
echo.

REM Install dependencies if node_modules does not exist
if not exist "node_modules" (
    echo [INFO] node_modules not found, running npm install...
    call npm install
)

echo.
echo [INFO] Starting K-Alert server on http://localhost:8889
call npm run start

echo.
echo [INFO] Server stopped or exited. Press any key to close...
pause >nul
