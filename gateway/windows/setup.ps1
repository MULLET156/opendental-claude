<#
  Open Dental Gateway: one-step setup for Windows.

  Installs (or updates) the gateway on this computer and runs it in the background
  at startup:
    - downloads Node.js (checked against nodejs.org's published checksums) into the
      install folder; nothing else on the computer is changed
    - asks for the Open Dental keys and tests them
    - optionally sets up the lab tracker sync (picks the in-house lab from a list,
      makes the shared secret, previews what would be sent)
    - creates the "Open Dental Gateway" startup task

  Run it by double-clicking Setup.cmd, or from an admin PowerShell:
    powershell -ExecutionPolicy Bypass -File gateway\windows\setup.ps1
  Run it again any time to change settings or update. To remove:
    powershell -ExecutionPolicy Bypass -File gateway\windows\setup.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "C:\OpenDentalGateway",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # makes downloads much faster in Windows PowerShell
$TaskName = "Open Dental Gateway"
$MinNode = 20

# ---------------------------------------------------------------- run as administrator

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $relaunch = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-InstallDir", "`"$InstallDir`"")
  if ($Uninstall) { $relaunch += "-Uninstall" }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $relaunch
  exit
}

try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

# ---------------------------------------------------------------- helpers

function Say([string]$text, [string]$color = "Gray") { Write-Host $text -ForegroundColor $color }
function Step([string]$text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }
function Good([string]$text) { Write-Host "   OK  $text" -ForegroundColor Green }
function Warn([string]$text) { Write-Host "   !   $text" -ForegroundColor Yellow }

function Ask([string]$question, [string]$default = "") {
  $prompt = if ($default) { "$question [$default]" } else { $question }
  $answer = Read-Host "   $prompt"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
  return $answer.Trim()
}

function AskYes([string]$question, [bool]$default = $true) {
  $hint = if ($default) { "Y/n" } else { "y/N" }
  while ($true) {
    $a = Read-Host "   $question ($hint)"
    if ([string]::IsNullOrWhiteSpace($a)) { return $default }
    if ($a -match '^(y|yes)$') { return $true }
    if ($a -match '^(n|no)$') { return $false }
  }
}

function AskSecret([string]$question) {
  $s = Read-Host "   $question" -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

# Describes what's wrong with a key without showing it.
function Describe-Key([string]$raw) {
  $problems = @()
  if ($raw -match '[\x00-\x1F\x7F]') { $problems += "a control character (this happens when Ctrl+V doesn't paste in this window: right-click to paste instead)" }
  if ($raw -match '[\u200B-\u200D\u2060\uFEFF\u00A0]') { $problems += "an invisible character copied along with the key" }
  if ($raw -match '[:=]') { $problems += "a ':' or '=' (paste only the key, not its label)" }
  if ($raw -match '[^\x00-\x7F]') { $problems += "a non-English character" }
  $other = ($raw -replace '[A-Za-z0-9_\-\s\x00-\x1F\x7F\u200B-\u200D\u2060\uFEFF\u00A0:=]', '')
  if ($other -match '[\x21-\x7E]') { $problems += "punctuation such as $((($other.ToCharArray() | Where-Object { [int]$_ -lt 127 } | Select-Object -Unique) -join ' '))" }
  $clean = $raw -replace '[\s\x00-\x1F\x7F\u200B-\u200D\u2060\uFEFF]', ''
  $problems += "$($clean.Length) characters long"
  return ($problems -join "; ")
}

# Asks for an Open Dental key. Removes spaces, line breaks, quotes and invisible characters
# picked up when copying; if it still doesn't look like a key, says why (without showing it)
# and offers to show the typing on screen.
function AskKey([string]$question) {
  $visible = $false
  while ($true) {
    if ($visible) { $raw = Read-Host "   $question (shown on screen)" } else { $raw = AskSecret $question }
    if ($null -eq $raw) { $raw = "" }
    $v = ($raw -replace '[\s\x00-\x1F\x7F\u200B-\u200D\u2060\uFEFF]', '').Trim([char[]]@([char]34, [char]39, [char]0x201C, [char]0x201D, [char]0x2018, [char]0x2019))
    if (-not $v) {
      if ($raw.Length) { Warn "Nothing was pasted. If Ctrl+V doesn't work in this window, right-click to paste." } else { Warn "This can't be blank." }
    } elseif ($v -match '^[A-Za-z0-9_-]{4,128}$') {
      return $v
    } else {
      Warn "That doesn't look like an Open Dental key: it has $(Describe-Key $raw)."
      Say "   Open Dental keys are letters and numbers only." "DarkGray"
    }
    if (-not $visible) { $visible = AskYes "Show what you paste on screen so you can check it?" $true }
  }
}

function Pause-End {
  Write-Host ""
  Read-Host "Press Enter to close"
}

function Read-EnvFile([string]$file) {
  $map = @{}
  if (Test-Path $file) {
    foreach ($line in [IO.File]::ReadAllLines($file)) {
      $l = $line.TrimStart([char]0xFEFF)
      if ($l -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$' -and -not $l.Trim().StartsWith("#")) { $map[$Matches[1]] = $Matches[2] }
    }
  }
  return $map
}

function Write-EnvFile([string]$file, [hashtable]$map) {
  $lines = @(
    "# Open Dental Gateway settings. Written by setup.ps1. Keep this file private.",
    "OD_DEVELOPER_KEY=$($map['OD_DEVELOPER_KEY'])",
    "OD_CUSTOMER_KEY=$($map['OD_CUSTOMER_KEY'])",
    "OD_BASE_URL=$($map['OD_BASE_URL'])"
  )
  if ($map['OD_API_PLAN']) { $lines += "OD_API_PLAN=$($map['OD_API_PLAN'])" }
  if ($map['LAB_SYNC_SECRET']) { $lines += "LAB_SYNC_SECRET=$($map['LAB_SYNC_SECRET'])" }
  if (-not (Test-Path $file)) { New-Item -ItemType File -Path $file | Out-Null }
  # Only administrators and the system (which runs the gateway) can read it.
  & icacls.exe $file /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" | Out-Null
  [IO.File]::WriteAllText($file, (($lines -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding $false))
}

# Runs node with the given arguments and returns its exit code, output and errors.
# (Start-Process keeps Windows PowerShell from turning Node's error output into exceptions.)
function Run-Node([string[]]$argList) {
  $o = [IO.Path]::GetTempFileName()
  $e = [IO.Path]::GetTempFileName()
  try {
    $quoted = $argList | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
    $p = Start-Process -FilePath $script:Node -ArgumentList $quoted -NoNewWindow -Wait -PassThru -RedirectStandardOutput $o -RedirectStandardError $e
    return [pscustomobject]@{ code = $p.ExitCode; out = ([IO.File]::ReadAllText($o)).Trim(); err = ([IO.File]::ReadAllText($e)).Trim() }
  } finally {
    Remove-Item $o, $e -Force -ErrorAction SilentlyContinue
  }
}

function Helper([string[]]$argList) {
  $r = Run-Node (@($script:HelperJs) + $argList)
  try { return ($r.out | ConvertFrom-Json) } catch { return [pscustomobject]@{ ok = $false; error = (($r.out + "`n" + $r.err).Trim()) } }
}

function Indent([string]$text) { return ($text -replace '(?m)^', '     ') }

function Stop-Gateway {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($t) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    # cmd.exe ends but node may linger for a moment; stop the gateway's node only.
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($script:NodeDir, [StringComparison]::OrdinalIgnoreCase) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
  }
}

# ---------------------------------------------------------------- paths

$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$AppDir   = Join-Path $InstallDir "app"
$script:NodeDir = Join-Path $InstallDir "node"
$DataDir  = Join-Path $InstallDir "data"
$LogDir   = Join-Path $DataDir "logs"
$Config   = Join-Path $DataDir "gateway.config.json"
$EnvFile  = Join-Path $DataDir ".env"
$script:Node = Join-Path $script:NodeDir "node.exe"
$Source   = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))

Write-Host ""
Write-Host "  Open Dental Gateway setup" -ForegroundColor White
Write-Host "  Install folder: $InstallDir" -ForegroundColor DarkGray

# ---------------------------------------------------------------- uninstall

if ($Uninstall) {
  Step "Removing the startup task"
  Stop-Gateway
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Good "Startup task removed. The gateway is stopped."
  } else { Good "There was no startup task." }
  if ((Test-Path $InstallDir) -and (AskYes "Also delete $InstallDir, including the saved keys and logs?" $false)) {
    Remove-Item -Recurse -Force $InstallDir
    Good "Deleted $InstallDir."
  }
  Pause-End
  exit
}

try {
  if (-not (Test-Path (Join-Path $Source "gateway\server.js"))) {
    throw "Can't find the gateway files next to this script ($Source). Run Setup.cmd from the unzipped download, or this script from the repository."
  }

  # ------------------------------------------------------------ 1. files

  Step "1/5  Installing files"
  New-Item -ItemType Directory -Force -Path $InstallDir, $DataDir, $LogDir | Out-Null
  Stop-Gateway

  if ($Source.TrimEnd('\') -ine $AppDir.TrimEnd('\')) {
    if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
    New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
    foreach ($item in @("core", "gateway", "package.json", "LICENSE")) {
      $p = Join-Path $Source $item
      if (Test-Path $p) { Copy-Item -Recurse -Force $p $AppDir }
    }
    Copy-Item -Force (Join-Path $Source "gateway\windows\Setup.cmd") (Join-Path $InstallDir "Setup.cmd")
    $version = (Get-Content -Raw (Join-Path $AppDir "package.json") | ConvertFrom-Json).version
    Good "Gateway $version copied to $AppDir"
  } else {
    Good "Using the installed copy in $AppDir"
  }
  $script:HelperJs = Join-Path $AppDir "gateway\windows\setup-helper.js"
  $CliJs = Join-Path $AppDir "gateway\cli.js"
  $ServerJs = Join-Path $AppDir "gateway\server.js"

  # ------------------------------------------------------------ 2. Node.js

  Step "2/5  Node.js"
  $haveNode = $false
  if (Test-Path $script:Node) {
    $v = (& $script:Node -v) -replace '^v', ''
    if ([int]($v.Split('.')[0]) -ge $MinNode) { $haveNode = $true; Good "Node.js $v is already in $script:NodeDir" }
  }
  if (-not $haveNode) {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
    Say "   Finding the current Node.js LTS release..."
    $index = Invoke-RestMethod -UseBasicParsing "https://nodejs.org/dist/index.json"
    $rel = $index | Where-Object { $_.lts -and ($_.files -contains "win-$arch-zip") -and ([int]($_.version.TrimStart('v').Split('.')[0]) -ge $MinNode) } | Select-Object -First 1
    if (-not $rel) { throw "Couldn't find a Node.js download for Windows $arch." }
    $name = "node-$($rel.version)-win-$arch"
    $tmp = Join-Path $env:TEMP ("odgw-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
      Say "   Downloading Node.js $($rel.version) ($arch)..."
      $zipPath = Join-Path $tmp "$name.zip"
      Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$($rel.version)/$name.zip" -OutFile $zipPath
      $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$($rel.version)/SHASUMS256.txt").Content
      $line = ($sums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape("$name.zip"))\s*$" } | Select-Object -First 1
      if (-not $line) { throw "Node.js checksum list doesn't include $name.zip." }
      $expected = ($line -split '\s+')[0].ToLower()
      $actual = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLower()
      if ($expected -ne $actual) { throw "The Node.js download doesn't match its published checksum. Nothing was installed; try again later." }
      Good "Download verified (SHA-256)"
      Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
      if (Test-Path $script:NodeDir) { Remove-Item -Recurse -Force $script:NodeDir }
      Move-Item (Join-Path $tmp $name) $script:NodeDir
    } finally {
      Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
    Good "Node.js $($rel.version) installed in $script:NodeDir (only the gateway uses it)"
  }

  # ------------------------------------------------------------ 3. Open Dental keys

  Step "3/5  Open Dental connection"
  $envMap = Read-EnvFile $EnvFile
  $current = Helper @("get", $Config)
  $keepAll = $false
  if ($envMap['OD_DEVELOPER_KEY'] -and $current.exists) {
    $keepAll = AskYes "Keep all current settings and just update/restart?" $true
  }

  $askKeys = -not $envMap['OD_DEVELOPER_KEY']
  if (-not $keepAll -and -not $askKeys) { $askKeys = -not (AskYes "Keep the saved Open Dental keys and address ($($envMap['OD_BASE_URL']))?" $true) }

  while ($true) {
    if ($askKeys) {
      Say ""
      Say "   Open Dental API address. On the Open Dental server itself use the default."
      Say "   On another office computer: http://<server address>:30223/api/v1"
      $default = if ($envMap['OD_BASE_URL']) { $envMap['OD_BASE_URL'] } else { "http://127.0.0.1:30223/api/v1" }
      $envMap['OD_BASE_URL'] = Ask "API address" $default
      if ($envMap['OD_BASE_URL'] -match 'api\.opendental\.com') {
        $envMap['OD_API_PLAN'] = Ask "Your Open Dental API plan (read-all, standard, enterprise)" $(if ($envMap['OD_API_PLAN']) { $envMap['OD_API_PLAN'] } else { "standard" })
      } else { $envMap.Remove('OD_API_PLAN') }
      Say "   Paste each key and press Enter. Typing is hidden; right-click pastes if Ctrl+V doesn't." 
      $envMap['OD_DEVELOPER_KEY'] = AskKey "Developer Key"
      $envMap['OD_CUSTOMER_KEY'] = AskKey "Customer Key"
      Write-EnvFile $EnvFile $envMap
    }
    Say "   Testing the connection..."
    $t = Helper @("test-od", $Config)
    if ($t.ok) { Good "Connected to Open Dental (providers found: $($t.providers))"; break }
    Warn $t.error
    if (-not (AskYes "Enter the address and keys again?" $true)) { throw "Open Dental connection failed." }
    $askKeys = $true
  }

  # ------------------------------------------------------------ 4. lab tracker sync

  Step "4/5  Lab tracker sync"
  $ls = $current.labSync
  $syncOn = $false
  $writeEnv = @{}
  if ($keepAll) {
    $syncOn = [bool]($ls -and $ls.enabled)
    Good $(if ($syncOn) { "Keeping the lab sync settings ($($ls.trackerUrl))" } else { "Lab sync stays off" })
  } else {
    Say "   Sends new Open Dental lab cases to a web lab tracker (patient as 'J. Smith' only)"
    Say "   and writes 'ready' (and 'sent' for outside labs) back. See docs\lab-tracker-sync.md."
    $syncOn = AskYes "Set up the lab tracker sync?" ([bool]($ls -and $ls.enabled))
  }

  if ($syncOn -and -not $keepAll) {
    while ($true) {
      $url = Ask "Tracker sync address (ends in /od-sync.php)" $(if ($ls) { $ls.trackerUrl } else { "https://" })
      if ($url -match '^https://[^/\s]+/.*od-sync\.php$') { break }
      Warn "It should look like https://lab.example.com/od-sync.php"
    }

    $labs = Helper @("labs", $Config)
    if ($labs.ok -and $labs.labs) {
      Say "   Labs in Open Dental:"
      foreach ($l in $labs.labs) { Say ("     {0,4}  {1}" -f $l.num, $l.name) }
    } else { Warn "Couldn't list labs: $($labs.error)" }
    $inHouse = Ask "Number(s) of your in-house lab(s), separated by commas (blank if none)" $(if ($ls) { $ls.inHouseLabs } else { "" })

    $today = (Get-Date).ToString("yyyy-MM-dd")
    Say "   Only lab cases created on or after the start date are sent (so old cases don't flood the tracker)."
    while ($true) {
      $from = Ask "Start date (yyyy-MM-dd)" $(if ($ls -and $ls.syncFrom) { $ls.syncFrom } else { $today })
      $d = [datetime]::MinValue
      if ([datetime]::TryParseExact($from, "yyyy-MM-dd", $null, [Globalization.DateTimeStyles]::None, [ref]$d)) { break }
      Warn "Use the form 2026-11-16."
    }

    Say "   How patients appear in the tracker:  1 = J. Smith    2 = J.S."
    $fmtDefault = if ($ls -and $ls.patientFormat -eq "initials") { "2" } else { "1" }
    $fmt = if ((Ask "Choose 1 or 2" $fmtDefault) -eq "2") { "initials" } else { "initial-last" }

    $newSecret = -not $envMap['LAB_SYNC_SECRET']
    if (-not $newSecret) { $newSecret = AskYes "Make a new shared secret? (No keeps the one already in the tracker)" $false }
    if ($newSecret) {
      $s = Helper @("secret")
      $envMap['LAB_SYNC_SECRET'] = $s.secret
      Write-EnvFile $EnvFile $envMap
      $phpLine = "define('OD_SYNC_SECRET', '$($s.secret)');"
      try { Set-Clipboard -Value $phpLine; $copied = $true } catch { $copied = $false }
      Say ""
      Say "   Add this line to the tracker's config.php on your web host" "White"
      Say "   (Hostinger: Websites > Manage > File Manager, in the tracker's folder), then save:" "White"
      Say ""
      Say "     $phpLine" "Yellow"
      Say ""
      if ($copied) { Good "The line is on the clipboard: paste it with Ctrl+V." }
      Say "   Don't email it or paste it into a chat." "DarkGray"
      Read-Host "   Press Enter once config.php is saved"
    }

    $writeEnv = @{ SETUP_LABSYNC = "1"; SETUP_TRACKER_URL = $url; SETUP_IN_HOUSE = $inHouse; SETUP_SYNC_FROM = $from; SETUP_PATIENT_FORMAT = $fmt }
  } elseif (-not $syncOn) {
    $writeEnv = @{ SETUP_LABSYNC = "0" }
  }

  if ($envMap['OD_API_PLAN']) { $writeEnv['SETUP_OD_PLAN'] = $envMap['OD_API_PLAN'] }
  foreach ($k in $writeEnv.Keys) { Set-Item -Path "Env:$k" -Value $writeEnv[$k] }
  try { $w = Helper @("write", $Config) } finally { foreach ($k in $writeEnv.Keys) { Remove-Item -Path "Env:$k" -ErrorAction SilentlyContinue } }
  if (-not $w.ok) { throw "Settings problem: $($w.error)" }
  Good "Settings saved to $Config"

  if ($syncOn) {
    Say "   Preview (reads Open Dental, sends nothing):"
    $preview = Run-Node @($CliJs, "lab-sync", $Config, "--dry-run")
    if ($preview.code -ne 0) { Warn $preview.err; Warn "The preview failed; fix the problem above and run Setup again." }
    else {
      Say (Indent $preview.out) "DarkGray"
      if (AskYes "Send to the tracker now and check it works?" $true) {
      $run = Run-Node @($CliJs, "lab-sync", $Config)
      if ($run.code -eq 0) {
        Good "The tracker answered. Result:"
        Say (Indent $run.out) "DarkGray"
      } else {
        Warn $run.err
        Say "   401 bad_signature: the secret in config.php doesn't match.  503 not_configured: the line isn't in config.php yet." "DarkGray"
        Say "   404: wrong address, or od-sync.php isn't on the web host.  'Could not reach': check the address and this computer's internet." "DarkGray"
        Say "   Fix it, then run Setup again. Nothing was changed in Open Dental." "DarkGray"
      }
      }
    }
  }

  # ------------------------------------------------------------ 5. startup task

  Step "5/5  Running in the background"
  $check = Run-Node @($CliJs, "check", $Config)
  if (-not $w.runnable) {
    Warn "Nothing for the gateway to do yet: the lab sync is off and no apps are set up."
    Say "   Add an app with:  $script:Node $CliJs new-key `"app name`"   then run Setup again." "DarkGray"
  } elseif ($check.code -ne 0) {
    Warn $check.err
  } else {
    $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c node\node.exe app\gateway\server.js data\gateway.config.json >> data\logs\gateway.log 2>&1" -WorkingDirectory $InstallDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Open Dental Gateway (lab tracker sync and app API). Installed by setup.ps1." -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 4
    $state = (Get-ScheduledTask -TaskName $TaskName).State
    $log = Join-Path $LogDir "gateway.log"
    $tail = if (Test-Path $log) { (Get-Content $log -Tail 6) -join "`n" } else { "" }
    if ($state -eq "Running") {
      Good "The gateway is running and will start automatically with Windows."
    } else {
      Warn "The startup task is '$state', not running. The log says:"
    }
    if ($tail) { Say (Indent $tail) "DarkGray" }
  }

  Write-Host ""
  Write-Host "  Done." -ForegroundColor Green
  Say "  Log:              $LogDir\gateway.log"
  Say "  Change settings:  run $InstallDir\Setup.cmd again"
  Say "  Remove:           powershell -ExecutionPolicy Bypass -File `"$AppDir\gateway\windows\setup.ps1`" -Uninstall"
} catch {
  Write-Host ""
  Write-Host "  Setup stopped: $($_.Exception.Message)" -ForegroundColor Red
  Say "  Nothing in Open Dental was changed. Fix the problem and run Setup again."
}
Pause-End
