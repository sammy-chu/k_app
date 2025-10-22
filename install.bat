@echo off
echo ========================================
echo        K线提醒系统依赖安装脚本
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

echo [信息] 正在安装项目依赖...
echo [信息] 这可能需要几分钟时间，请耐心等待...
echo.

REM 清理旧的node_modules（可选）
if exist "node_modules" (
    echo [信息] 发现已存在的node_modules目录
    set /p choice="是否要重新安装依赖？(y/N): "
    if /i "%choice%"=="y" (
        echo [信息] 正在清理旧的依赖...
        rmdir /s /q node_modules
        if exist "package-lock.json" del package-lock.json
    ) else (
        echo [信息] 跳过依赖安装
        goto :end
    )
)

REM 安装依赖
npm install
if %errorlevel% neq 0 (
    echo [错误] 依赖安装失败
    echo [建议] 请检查网络连接或尝试使用淘宝镜像：
    echo         npm config set registry https://registry.npmmirror.com
    pause
    exit /b 1
)

echo.
echo [成功] 依赖安装完成！
echo [信息] 现在可以运行以下命令启动项目：
echo         双击 start.bat    - 生产模式启动
echo         双击 dev.bat      - 开发模式启动
echo         npm run start     - 命令行启动
echo         npm run dev       - 命令行开发模式

:end
echo.
pause