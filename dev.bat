@echo off
echo ========================================
echo      K线提醒系统开发模式启动脚本
echo ========================================
echo.

REM 检查Node.js是否安装
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到Node.js，请先安装Node.js
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

REM 显示Node.js版本
echo [信息] Node.js版本:
node --version

REM 检查npm是否可用
npm --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] npm不可用，请检查Node.js安装
    pause
    exit /b 1
)

echo [信息] npm版本:
npm --version
echo.

REM 检查package.json是否存在
if not exist "package.json" (
    echo [错误] 未找到package.json文件，请确保在正确的项目目录中运行
    pause
    exit /b 1
)

REM 检查node_modules是否存在，如果不存在则安装依赖
if not exist "node_modules" (
    echo [信息] 未找到node_modules目录，正在安装依赖...
    npm install
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
    echo [成功] 依赖安装完成
    echo.
)

REM 设置开发环境变量
set NODE_ENV=development
REM set ALERT_THRESHOLD_PCT=0.005
REM set PGHOST=localhost
REM set PGPORT=5432
REM set PGDATABASE=ppro8_market_data
REM set PGUSER=postgres
REM set PGPASSWORD=postgres

echo [信息] 正在启动K线提醒系统（开发模式）...
echo [信息] 服务地址: http://localhost:3000
echo [信息] 提醒页面: http://localhost:3000/alerts
echo [信息] 开发模式：文件修改后自动重启
echo [信息] 按 Ctrl+C 停止服务
echo.

REM 启动开发模式
npm run dev

REM 如果程序异常退出，暂停以查看错误信息
if %errorlevel% neq 0 (
    echo.
    echo [错误] 程序异常退出，错误代码: %errorlevel%
    pause
)