@echo off
setlocal
cd /d "%~dp0"
set "DATA=%~dp0data"

if not exist "%DATA%\server.pid" (
  echo Server is not running.
  powershell -NoProfile -Command "Start-Sleep -Seconds 2"
  exit /b 0
)

set "SPID="
set /p SPID=<"%DATA%\server.pid"
if "%SPID%"=="" (
  del /q "%DATA%\server.pid" >nul 2>&1
  echo Server is not running.
  powershell -NoProfile -Command "Start-Sleep -Seconds 2"
  exit /b 0
)

powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter ('ProcessId=%SPID%') -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine -match 'server\.js') { Stop-Process -Id %SPID% -Force; Write-Output 'Server stopped.' } else { Write-Output 'Server was not running.' }"
del /q "%DATA%\server.pid" "%DATA%\port.txt" >nul 2>&1
powershell -NoProfile -Command "Start-Sleep -Seconds 2"
