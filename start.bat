@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo [start] installing dependencies...
  call npm install || goto :fail
)
if "%PORT%"=="" set PORT=8787
if "%HOST%"=="" set HOST=0.0.0.0
echo [start] lucky-esa-panel on http://%HOST%:%PORT%
call npm start
echo.
echo [start] node exited with code %errorlevel%.
exit /b %errorlevel%

:fail
echo [start] failed with error %errorlevel%
pause
exit /b %errorlevel%