@echo off
setlocal
cd /d "%~dp0"
set "DIR=%CD%"
set "DATA=%DIR%\data"
if not exist "%DATA%" mkdir "%DATA%" >nul 2>&1
set "QUIET="
if /I "%~1"=="/quiet" set "QUIET=1"

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
  if defined QUIET exit /b 1
  echo Node.js is not installed. Starting the automatic installer...
  call "%~dp0install.bat"
  exit /b 0
)

set "CHECKPORT=3000"
if exist "%DATA%\port.txt" set /p CHECKPORT=<"%DATA%\port.txt"
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 ('http://localhost:%CHECKPORT%/api/ping'); if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
if not errorlevel 1 (
  if not defined QUIET start "" "http://localhost:%CHECKPORT%/"
  exit /b 0
)

if not exist node_modules (
  if not defined QUIET echo Installing requirements for the first run...
  set "NPM_CMD=npm"
  where npm >nul 2>nul || set "NPM_CMD=%ProgramFiles%\nodejs\npm.cmd"
  call "%NPM_CMD%" install --no-audit --no-fund > "%DIR%\install.log" 2>&1
  if errorlevel 1 (
    if not defined QUIET powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('npm install failed. See install.log in the app folder.','WiFi File Transfer')"
    exit /b 1
  )
)

del /q "%DATA%\port.txt" "%DATA%\server.pid" >nul 2>&1
del /q "%DATA%\server.log" "%DATA%\server.err.log" >nul 2>&1
powershell -NoProfile -Command "Start-Process -FilePath '%NODE_EXE%' -ArgumentList 'server.js' -WorkingDirectory '%DIR%' -WindowStyle Hidden -RedirectStandardOutput '%DATA%\server.log' -RedirectStandardError '%DATA%\server.err.log'"

powershell -NoProfile -Command "$d=(Get-Date).AddSeconds(20); while ((Get-Date) -lt $d -and -not (Test-Path '%DATA%\port.txt')) { Start-Sleep -Milliseconds 300 }; if (Test-Path '%DATA%\port.txt') { exit 0 } else { exit 1 }"
if errorlevel 1 goto :fail

if not defined QUIET (
  set "PORT="
  set /p PORT=<"%DATA%\port.txt"
  start "" "http://localhost:%PORT%/"
)
exit /b 0

:fail
if not defined QUIET powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('The server did not start. Open server.err.log in the data folder to see the error.','WiFi File Transfer')"
exit /b 1
