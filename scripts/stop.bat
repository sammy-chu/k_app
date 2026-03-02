@echo off
echo Stopping K App background processes...

:: 1. Kill the loop script wrapper (cmd.exe)
echo Finding and killing loop processes...
for /f "tokens=2 delims==" %%I in ('wmic process where "name='cmd.exe' and commandline like '%%run_loop.bat%%'" get processid /value 2^>nul') do (
    echo Killing loop process PID: %%I
    taskkill /F /PID %%I 2>nul
)

:: 2. Kill node.exe processes
echo Killing node processes...
taskkill /F /IM node.exe 2>nul

echo [SUCCESS] All processes should be stopped now.
echo.
pause
