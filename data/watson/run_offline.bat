@echo off
setlocal
cd /d "%~dp0"
set "PYTHONUTF8=1"
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 crawl.py --offline --run-dir data
) else (
    python crawl.py --offline --run-dir data
)
if errorlevel 1 echo FAILED. Copy the ERROR above.
pause
