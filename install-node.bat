@echo off
setlocal EnableExtensions
set "MSI="
if exist "%~dp0setup\node-x64.msi" set "MSI=%~dp0setup\node-x64.msi"

where node >nul 2>nul
if not errorlevel 1 exit /b 0
if exist "%ProgramFiles%\nodejs\node.exe" exit /b 0
if exist "%LocalAppData%\Programs\nodejs\node.exe" exit /b 0

powershell -NoProfile -Command "if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 } else { exit 1 }"
if errorlevel 1 goto :elevate

echo  Installing Node.js silently ...
if defined MSI goto :installmsi
set "MSI=%TEMP%\node-v24.22.3-x64.msi"
del /q "%MSI%" >nul 2>&1
echo  Downloading Node.js from nodejs.org ...
powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/v24.22.3/node-v24.22.3-x64.msi' -OutFile '%TEMP%\node-v24.22.3-x64.msi'; exit 0 } catch { exit 1 }"
if errorlevel 1 goto :winget
for %%A in ("%MSI%") do set "MSIZE=%%~zA"
if not defined MSIZE goto :winget
if %MSIZE% LSS 20000000 goto :winget

:installmsi
start /wait "" msiexec /i "%MSI%" /qn /norestart /l*v "%TEMP%\wft-node-install.log"
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto :installed
if "%RC%"=="3010" goto :installed
echo  The installer returned code %RC%. Trying the Windows package manager ...
goto :winget

:winget
where winget >nul 2>nul
if errorlevel 1 goto :nointernet
winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
if exist "%ProgramFiles%\nodejs\node.exe" goto :installed
where node >nul 2>nul
if not errorlevel 1 goto :installed
goto :nointernet

:installed
if /I "%MSI%"=="%TEMP%\node-v24.22.3-x64.msi" del /q "%MSI%" >nul 2>&1
set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if exist "%NODE_EXE%" goto :verify
set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"
if exist "%NODE_EXE%" goto :verify
where node >nul 2>nul
if errorlevel 1 goto :nointernet
set "NODE_EXE=node"
:verify
echo  Node.js ready:
"%NODE_EXE%" -v
if errorlevel 1 goto :nointernet
call "%~dp0allow-firewall.bat" --elevated
exit /b 0

:elevate
echo  Node.js is not installed. Requesting administrator permission ...
powershell -NoProfile -Command "try { Start-Process -FilePath '%~f0' -Verb RunAs -Wait } catch { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Administrator permission is required to install Node.js. Click Yes on the Windows prompt.','WiFi File Transfer') }"
where node >nul 2>nul
if not errorlevel 1 exit /b 0
if exist "%ProgramFiles%\nodejs\node.exe" exit /b 0
if exist "%LocalAppData%\Programs\nodejs\node.exe" exit /b 0
exit /b 1

:nointernet
powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Node.js could not be installed automatically. Check the internet connection, or install Node.js LTS from https://nodejs.org and then run the app again.','WiFi File Transfer')"
exit /b 1
