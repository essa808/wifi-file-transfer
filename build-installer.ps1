# Builds dist\WiFi-File-Transfer-Setup.exe (self-extracting, uses Windows' built-in IExpress).
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$stage = Join-Path $env:TEMP 'wft-build'
$app = Join-Path $stage 'app'
$dist = Join-Path $root 'dist'
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $app, $dist | Out-Null

# app payload: code + dependencies only (never data, token, clips)
foreach ($f in 'server.js', 'package.json', 'package-lock.json', 'start.bat', 'stop.bat', 'launch.vbs', 'autostart.vbs') { Copy-Item (Join-Path $root $f) $app }
Copy-Item (Join-Path $root 'installer\uninstall.ps1') $app
Copy-Item (Join-Path $root 'installer\app-icon.ico') $app
robocopy (Join-Path $root 'public') (Join-Path $app 'public') /E /NFL /NDL /NJH /NJS | Out-Null
robocopy (Join-Path $root 'node_modules') (Join-Path $app 'node_modules') /E /NFL /NDL /NJH /NJS | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($app, (Join-Path $stage 'app.zip'), 'Optimal', $false)
Remove-Item $app -Recurse -Force

Copy-Item (Join-Path $root 'setup\node-x64.msi') $stage
Copy-Item (Join-Path $root 'installer\install.ps1'), (Join-Path $root 'installer\run.cmd') $stage

# IExpress reads the .sed as ASCII, so it must write to an ASCII path; the result is copied into dist\ afterwards
# (this folder may sit under a non-English path such as "أدوات ودرايفرات").
$final = Join-Path $dist 'WiFi-File-Transfer-Setup.exe'
$exe = Join-Path $stage 'WiFi-File-Transfer-Setup.exe'
Remove-Item $exe -Force -ErrorAction SilentlyContinue
$files = 'run.cmd', 'install.ps1', 'app.zip', 'node-x64.msi'
$strings = ($files | ForEach-Object -Begin { $i = 0 } -Process { "FILE$i=`"$_`""; $i++ }) -join "`r`n"
$list = (0..($files.Count - 1) | ForEach-Object { "%FILE$_%=" }) -join "`r`n"
$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$exe
FriendlyName=WiFi File Transfer Setup
AppLaunched=cmd /c run.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
$strings
[SourceFiles]
SourceFiles0=$stage\
[SourceFiles0]
$list
"@
$sedPath = Join-Path $stage 'installer.sed'
Set-Content $sedPath $sed -Encoding ASCII
Start-Process "$env:SystemRoot\System32\iexpress.exe" -ArgumentList @('/N', '/Q', 'installer.sed') -WorkingDirectory $stage -Wait
# IExpress finishes writing the exe slightly after its own process exits
for ($i = 0; $i -lt 60 -and -not (Test-Path $exe); $i++) { Start-Sleep -Seconds 2 }
if (-not (Test-Path $exe)) { throw 'IExpress did not produce the installer.' }
Start-Sleep -Seconds 3
Copy-Item $exe $final -Force
Write-Host ("Built {0} ({1:N1} MB)" -f $final, ((Get-Item $final).Length / 1MB))
