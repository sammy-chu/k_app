@echo off
echo Stopping run_loop.bat...
wmic process where "name='cmd.exe' and commandline like '%%run_loop.bat%%'" call terminate
echo Stopped.
