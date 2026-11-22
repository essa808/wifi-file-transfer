param([switch]$Quiet)

# Removes the app. Node.js stays installed.
$ErrorActionPreference = 'Continue'
$App = 'WiFi File Transfer'
$Dir = $PSScriptRoot
$Data = Join-Path $Dir 'data'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Add-Type -AssemblyName PresentationFramework

if (-not $Quiet) {
  $answer = [System.Windows.MessageBox]::Show(
    "هل تريد إزالة $App من هذا الكمبيوتر؟`n`nملفاتك المستلمة تبقى في مجلد Downloads، والملفات المرسلة تبقى في مجلد Documents.",
    $App, [System.Windows.MessageBoxButton]::YesNoCancel, [System.Windows.MessageBoxImage]::Question)
  if ($answer -ne [System.Windows.MessageBoxResult]::Yes) { exit 0 }
}

if (-not $admin) {
  try {
    $psArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    if ($Quiet) { $psArgs += ' -Quiet' }
    $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList $psArgs
    exit $p.ExitCode
  } catch {
    [void][System.Windows.MessageBox]::Show("لم تتم الإزالة: أُلغيت نافذة صلاحيات المسؤول.", $App)
    exit 1
  }
}

foreach ($pidFile in (Join-Path $Data 'server.pid'), (Join-Path $Dir 'server.pid')) {
  if (-not (Test-Path $pidFile)) { continue }
  $old = [int](Get-Content $pidFile -TotalCount 1)
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$old" -ErrorAction SilentlyContinue
  if ($proc -and $proc.CommandLine -match 'server\.js') { Stop-Process -Id $old -Force }
  break
}
Get-NetFirewallRule -DisplayName "$App*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Remove-Item (Join-Path ([Environment]::GetFolderPath('CommonStartup')) "$App.lnk"), (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) "$App.lnk") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) $App), (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) "إزالة WiFi File Transfer.lnk") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\WiFiFileTransfer' -Force -ErrorAction SilentlyContinue

# keep the paired devices and transfer history unless the user chose a full clean-up
$wipe = $false
if (-not $Quiet) {
  $answer = [System.Windows.MessageBox]::Show(
    "تمت إزالة البرنامج.`n`nهل تحذف أيضاً سجل البرنامج (الأجهزة المربوطة والنصوص المنقولة)؟`nاختر «لا» إذا كنت تنوي تثبيته مرة أخرى قريباً.",
    $App, [System.Windows.MessageBoxButton]::YesNo, [System.Windows.MessageBoxImage]::Question)
  $wipe = ($answer -eq [System.Windows.MessageBoxResult]::Yes)
}

takeown /F $Dir /R /D Y 2>&1 | Out-Null
icacls $Dir /reset /T /C /Q 2>&1 | Out-Null
if ($wipe) {
  Remove-Item $Dir -Recurse -Force -ErrorAction SilentlyContinue
} else {
  Get-ChildItem $Dir -Force | Where-Object { $_.Name -notin 'data', 'uninstall.ps1' } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not $Quiet) {
  $sf = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -ErrorAction SilentlyContinue
  $Doc = [Environment]::GetFolderPath('MyDocuments')
  $Dl = if ($sf) { [Environment]::ExpandEnvironmentVariables($sf.'{374DE290-123F-4565-9164-39C4925E467B}') } else { Join-Path $env:USERPROFILE 'Downloads' }
  [void][System.Windows.MessageBox]::Show("تمت إزالة $App.`n`nملفاتك ما زالت في:`n$Doc\WiFi File Transfer`n$Dl\WiFi File Transfer", $App)
}
