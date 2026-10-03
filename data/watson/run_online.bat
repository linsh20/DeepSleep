@echo off
setlocal
cd /d "%~dp0"
set "PYTHONUTF8=1"
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 crawl.py
) else (
    python crawl.py
)
if errorlevel 1 (
    echo FAILED. Copy the ERROR above. Completed raw pages are preserved.
) else (
    echo Finished. Open the output folder printed above.
)
pause
