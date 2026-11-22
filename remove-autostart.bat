@echo off
setlocal
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\WiFi File Transfer.lnk"

if exist "%LNK%" (
  del /q "%LNK%"
  echo Autostart removed. The server will no longer start with Windows.
) else (
  echo Autostart was not enabled.
)
powershell -NoProfile -Command "Start-Sleep -Seconds 2"
