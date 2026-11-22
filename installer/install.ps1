# Installs WiFi File Transfer: Node.js (if missing), app files, firewall rule, shortcuts, autostart.
param(
  [string]$Dir = (Join-Path $env:ProgramData 'WiFi File Transfer'),
  [switch]$SkipSystem   # test mode: only extract files, no firewall/shortcuts/registry/Node/launch
)
$ErrorActionPreference = 'Stop'
$App = 'WiFi File Transfer'
$here = $PSScriptRoot
$Data = Join-Path $Dir 'data'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin -and -not $SkipSystem) {
  try {
    $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit $p.ExitCode
  } catch {
    Add-Type -AssemblyName PresentationFramework
    [void][System.Windows.MessageBox]::Show("لم يتم التثبيت: أُلغيت نافذة صلاحيات المسؤول.`n`nشغّل ملف التثبيت مرة أخرى واضغط «نعم» عند ظهور النافذة.", $App)
    exit 1
  }
}

Start-Transcript -Path (Join-Path $env:TEMP 'wft-install.log') -Force | Out-Null

function Find-Node {
  foreach ($p in "$env:ProgramFiles\nodejs\node.exe", "$env:LocalAppData\Programs\nodejs\node.exe") { if (Test-Path $p) { return $p } }
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
}
function Node-Ok($n) {
  if (-not $n) { return $false }
  try { return [int]((& $n -v) -replace '^v(\d+).*', '$1') -ge 18 } catch { return $false }
}
function Link($path, $target, $arguments, $desc, $style = 1, $icon = '') {
  New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
  $s.TargetPath = $target; $s.Arguments = $arguments; $s.WorkingDirectory = $Dir
  $s.WindowStyle = $style; $s.Description = $desc
  if ($icon) { $s.IconLocation = $icon }
  $s.Save()
}

try {
  Write-Host "`n  Installing $App ...`n"

  Write-Host '  [1/6] Checking Node.js'
  if (-not $SkipSystem -and -not (Node-Ok (Find-Node))) {
    Write-Host '        Installing Node.js silently (about 1 minute) ...'
    $p = Start-Process msiexec -Wait -PassThru -ArgumentList "/i `"$here\node-x64.msi`" /qn /norestart /l*v `"$env:TEMP\wft-node-install.log`""
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "Node.js installer failed (code $($p.ExitCode))." }
    if (-not (Node-Ok (Find-Node))) { throw 'Node.js was installed but could not be found.' }
  }

  Write-Host '  [2/6] Copying files'
  # older installers left program files unreadable even to this installer: take them back
  # before reading the pid file or overwriting anything
  $ErrorActionPreference = 'SilentlyContinue'
  takeown /F $Dir /R /D Y | Out-Null
  icacls $Dir /reset /T /C /Q | Out-Null
  $ErrorActionPreference = 'Stop'
  foreach ($pidPath in (Join-Path $Data 'server.pid'), (Join-Path $Dir 'server.pid')) {   # upgrade: stop the old server first
    if (-not (Test-Path $pidPath)) { continue }
    $old = [int](Get-Content $pidPath -TotalCount 1)
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$old" -ErrorAction SilentlyContinue
    if ($proc -and $proc.CommandLine -match 'server\.js') { Stop-Process -Id $old -Force; Start-Sleep -Seconds 1 }
    break
  }
  # older versions kept the data beside the program; move it once into data\
  if (-not (Test-Path $Data)) {
    New-Item -ItemType Directory -Force -Path $Data | Out-Null
    foreach ($n in 'uploads', 'shared', 'token.txt', 'clips.json', 'port.txt', 'server.pid', 'crash.log', 'server.log', 'server.err.log') {
      $oldPath = Join-Path $Dir $n
      if (Test-Path $oldPath) { Move-Item $oldPath (Join-Path $Data $n) -Force -ErrorAction SilentlyContinue }
    }
  }
  New-Item -ItemType Directory -Force -Path $Dir, $Data, (Join-Path $Data 'uploads'), (Join-Path $Data 'shared'), (Join-Path $Data '_deleted') | Out-Null
  # replace the old program files instead of overwriting them in place (stale files, locked ACLs)
  Get-ChildItem $Dir -Force | Where-Object { $_.Name -ne 'data' } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $here 'app.zip'))
  try {
    foreach ($e in $zip.Entries) {
      if (-not $e.Name) { continue }
      $t = Join-Path $Dir $e.FullName
      New-Item -ItemType Directory -Force -Path (Split-Path $t) | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $t, $true)
    }
  } finally { $zip.Dispose() }

  if (-not $SkipSystem) {
    Write-Host '  [3/6] Limiting permissions (program files read-only, data writable)'
    # /reset first: repairs ACLs left unreadable by older installers. Then set the root ACL
    # only and let children inherit it; per-file ACL surgery is what broke read access.
    $ErrorActionPreference = 'SilentlyContinue'
    icacls $Dir /reset /T /C /Q | Out-Null
    icacls $Dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
    icacls $Data /grant:r '*S-1-5-32-545:(OI)(CI)M' /T /C /Q | Out-Null
    $ErrorActionPreference = 'Stop'

    Write-Host '  [4/6] Opening the firewall for the local network'
    Get-NetFirewallRule -DisplayName "$App*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName "$App (TCP 3000-3020)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000-3020 -RemoteAddress LocalSubnet -Profile Any | Out-Null

    Write-Host '  [5/6] Creating shortcuts and Windows startup entry'
    # the two browsable folders live in the user's profile, not in data\
    $sf = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
    $Dl = [Environment]::ExpandEnvironmentVariables($sf.'{374DE290-123F-4565-9164-39C4925E467B}')
    $Doc = [Environment]::GetFolderPath('MyDocuments')
    $Inbox = Join-Path $Dl 'WiFi File Transfer\من الهاتف'
    $Outbox = Join-Path $Doc 'WiFi File Transfer\إلى الهاتف'
    New-Item -ItemType Directory -Force -Path $Inbox, $Outbox | Out-Null
    $ws = "$env:SystemRoot\System32\wscript.exe"
    $icon = "$Dir\app-icon.ico"
    $menu = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) $App
    Link (Join-Path ([Environment]::GetFolderPath('CommonStartup')) "$App.lnk") $ws "`"$Dir\autostart.vbs`"" $App 7 $icon
    Link (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) "$App.lnk") $ws "`"$Dir\launch.vbs`"" $App 1 $icon
    Link "$menu\$App.lnk" $ws "`"$Dir\launch.vbs`"" $App 1 $icon
    Link "$menu\Stop server.lnk" "$Dir\stop.bat" '' 'Stop the server' 7
    Link "$menu\Shared folder.lnk" $Outbox '' 'Files shared to the phone'
    Link "$menu\Uploads folder.lnk" $Inbox '' 'Files received from the phone'
    Link "$menu\إزالة WiFi File Transfer.lnk" "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File `"$Dir\uninstall.ps1`"" "Uninstall $App" 1 "$env:SystemRoot\System32\shell32.dll,131"
    Link (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) "إزالة WiFi File Transfer.lnk") "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File `"$Dir\uninstall.ps1`"" "Uninstall $App" 1 "$env:SystemRoot\System32\shell32.dll,131"
    Remove-Item "$menu\Uninstall.lnk" -Force -ErrorAction SilentlyContinue

    $key = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\WiFiFileTransfer'
    New-Item -Path $key -Force | Out-Null
    $reg = @{
      DisplayName = "WiFi File Transfer — نقل الملفات عبر الواي فاي"
      DisplayVersion = '1.0.0'
      DisplayIcon = $icon
      InstallLocation = $Dir
      Publisher = 'Local'
      InstallDate = (Get-Date -Format 'yyyyMMdd')
      UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Dir\uninstall.ps1`""
      QuietUninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Dir\uninstall.ps1`" -Quiet"
    }
    foreach ($k in $reg.Keys) { Set-ItemProperty $key $k $reg[$k] }
    Set-ItemProperty $key NoModify 1 -Type DWord
    Set-ItemProperty $key NoRepair 1 -Type DWord

    Write-Host '  [6/6] Starting the app'
    # explorer runs it as the normal desktop user, not as this elevated installer
    Start-Process explorer.exe -ArgumentList "`"$Dir\launch.vbs`""
    $portFile = Join-Path $Data 'port.txt'
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Path $portFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-Path $portFile)) {
      Write-Host '        Retry: launching directly with wscript'
      Start-Process $ws -ArgumentList "`"$Dir\launch.vbs`""
      $deadline = (Get-Date).AddSeconds(20)
      while (-not (Test-Path $portFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    }
  }
  Write-Host "`n  Done. The browser will open on the app page.`n"
  Start-Sleep -Seconds 3
} catch {
  Write-Host "`n  FAILED: $_`n  Log: $env:TEMP\wft-install.log"
  Add-Type -AssemblyName PresentationFramework
  [void][System.Windows.MessageBox]::Show("Install failed:`n$_`n`nLog: $env:TEMP\wft-install.log", $App)
  exit 1
}
