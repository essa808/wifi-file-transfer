@echo off
setlocal
set "RULE=WiFi File Transfer (TCP 3000)"

if /I "%~1"=="--elevated" goto :addrule

powershell -NoProfile -Command "if (Get-NetFirewallRule -DisplayName 'WiFi File Transfer (TCP 3000)' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  echo Firewall rule already exists. Nothing to do.
  powershell -NoProfile -Command "Start-Sleep -Seconds 2"
  exit /b 0
)

echo Requesting administrator permission...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '--elevated' -Verb RunAs -Wait"
exit /b 0

:addrule
powershell -NoProfile -Command "if (Get-NetFirewallRule -DisplayName 'WiFi File Transfer (TCP 3000)' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  echo Firewall rule already exists. Nothing to do.
  exit /b 0
)
netsh advfirewall firewall add rule name="%RULE%" dir=in action=allow protocol=TCP localport=3000 profile=any remoteip=LocalSubnet
powershell -NoProfile -Command "Start-Sleep -Seconds 2"
exit /b 0
