@echo off
rem Double-click to start Boostbook for Desktop. Leave this window open while you use it.
cd /d "%~dp0"
"runtime\windows-x86_64\python\python.exe" -I -u app\start.py %*
if errorlevel 1 (
    echo.
    echo Boostbook for Desktop stopped with an error ^(above^).
    pause
)
