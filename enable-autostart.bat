@echo off
setlocal
powershell -NoProfile -Command "$q=[char]34; $dir='%~dp0'.TrimEnd('\'); $ws=New-Object -ComObject WScript.Shell; $p=$env:APPDATA+'\Microsoft\Windows\Start Menu\Programs\Startup\WiFi File Transfer.lnk'; $s=$ws.CreateShortcut($p); $s.TargetPath='C:\Windows\System32\wscript.exe'; $s.Arguments=$q+$dir+'\autostart.vbs'+$q; $s.WorkingDirectory=$dir; $s.WindowStyle=7; $s.Description='WiFi File Transfer'; $s.Save(); Write-Output 'Autostart enabled.'"
powershell -NoProfile -Command "Start-Sleep -Seconds 2"
