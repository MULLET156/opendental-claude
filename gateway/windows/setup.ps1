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
# A small Windows box for one key: normal Ctrl+V / right-click paste, hidden by default
# with a "Show" box to check it. Returns $null if cancelled; throws if Windows Forms
# isn't available (the caller then asks in the console instead).
function AskKeyDialog([string]$question, [string]$problem = "") {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $form = New-Object System.Windows.Forms.Form
  $form.Text = "Open Dental Gateway setup"
  $form.StartPosition = "CenterScreen"
  $form.TopMost = $true
  $form.FormBorderStyle = "FixedDialog"
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.Font = New-Object System.Drawing.Font("Segoe UI", 10)
  $form.ClientSize = New-Object System.Drawing.Size(460, 190)

  $label = New-Object System.Windows.Forms.Label
  $label.Text = "Paste the Open Dental $question here (Ctrl+V, or right-click > Paste):"
  $label.Location = New-Object System.Drawing.Point(14, 14)
  $label.Size = New-Object System.Drawing.Size(432, 22)

  $box = New-Object System.Windows.Forms.TextBox
  $box.Location = New-Object System.Drawing.Point(14, 42)
  $box.Size = New-Object System.Drawing.Size(432, 26)
  $box.UseSystemPasswordChar = $true

  $show = New-Object System.Windows.Forms.CheckBox
  $show.Text = "Show"
  $show.Location = New-Object System.Drawing.Point(14, 76)
  $show.AutoSize = $true
  $show.Add_CheckedChanged({ $box.UseSystemPasswordChar = -not $show.Checked })

  $note = New-Object System.Windows.Forms.Label
  $note.Text = $problem
  $note.ForeColor = [System.Drawing.Color]::Firebrick
  $note.Location = New-Object System.Drawing.Point(14, 104)
  $note.Size = New-Object System.Drawing.Size(432, 40)

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = "OK"
  $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $ok.Location = New-Object System.Drawing.Point(270, 150)
  $ok.Size = New-Object System.Drawing.Size(84, 30)

  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = "Cancel"
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $cancel.Location = New-Object System.Drawing.Point(362, 150)
  $cancel.Size = New-Object System.Drawing.Size(84, 30)

  $form.AcceptButton = $ok
  $form.CancelButton = $cancel
  $form.Controls.AddRange(@($label, $box, $show, $note, $ok, $cancel))
  $form.Add_Shown({ $form.Activate(); $box.Focus() | Out-Null })
  try {
    $result = $form.ShowDialog()
    $text = $box.Text
  } finally {
    $form.Dispose()
  }
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
  return $text
}

# Cleans a pasted key: removes spaces, line breaks, invisible characters and quotes.
function Clean-Key([string]$raw) {
  return ($raw -replace '[\s\x00-\x1F\x7F\u200B-\u200D\u2060\uFEFF]', '').Trim([char[]]@([char]34, [char]39, [char]0x201C, [char]0x201D, [char]0x2018, [char]0x2019))
}

# Asks for an Open Dental key in a pop-up box (console as a fallback). If it still doesn't
# look like a key after cleaning, says why without showing it, and asks again.
function AskKey([string]$question) {
  $useDialog = $true
  $visible = $false
  $problem = ""
  while ($true) {
    $raw = $null
    if ($useDialog) {
      try {
        Say "   $($question): paste it in the window that just opened." "White"
        $raw = AskKeyDialog $question $problem
        if ($null -eq $raw) { throw (New-Object OperationCanceledException "Setup was cancelled.") }
      } catch [OperationCanceledException] {
        throw
      } catch {
        $useDialog = $false
        Warn "Couldn't open the pop-up window, so type or paste the key here instead."
        continue
      }
    } elseif ($visible) {
      $raw = Read-Host "   $question (shown on screen)"
    } else {
      $raw = AskSecret $question
    }
    if ($null -eq $raw) { $raw = "" }
    $v = Clean-Key $raw
    if (-not $v) {
      $problem = if ($raw.Length) { "Nothing was pasted. Copy the key again, then paste it." } else { "This can't be blank." }
    } elseif ($v -match '^[A-Za-z0-9_-]{4,128}$') {
      return $v
    } else {
      $problem = "That doesn't look like an Open Dental key: it has $(Describe-Key $raw). Keys are letters and numbers only."
    }
    Warn $problem
    if (-not $useDialog -and -not $visible) { $visible = AskYes "Show what you paste on screen so you can check it?" $true }
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

# ---------------------------------------------------------------- settings.txt

$SettingNames = @("DEVELOPER_KEY", "CUSTOMER_KEY", "OPEN_DENTAL_ADDRESS", "API_PLAN", "LAB_SYNC", "LAB_TRACKER_ADDRESS", "IN_HOUSE_LABS", "SYNC_START_DATE", "PATIENT_FORMAT", "SEND_PATIENT_NUMBER", "SHARED_SECRET", "SEND_TEST")

# Reads NAME=value lines (comments start with #). Returns only the values filled in.
function Read-Settings([string]$file) {
  $map = @{}
  if (-not $file -or -not (Test-Path $file)) { return $map }
  foreach ($line in [IO.File]::ReadAllLines($file)) {
    $l = $line.TrimStart([char]0xFEFF).Trim()
    if (-not $l -or $l.StartsWith("#")) { continue }
    if ($l -notmatch '^([A-Za-z_]+)\s*=\s*(.*)$') { Warn "settings.txt: ignoring a line that isn't NAME=value"; continue }
    $name = $Matches[1].ToUpper()
    $value = $Matches[2].Trim().Trim([char[]]@([char]34, [char]39))
    if ($SettingNames -notcontains $name) { Warn "settings.txt: '$name' isn't a setting Setup knows; check the spelling"; continue }
    if ($value) { $map[$name] = $value }
  }
  return $map
}

# Blanks the named values in settings.txt (keys and secret, once saved securely).
function Scrub-Settings([string]$file, [string[]]$names) {
  if (-not $file -or -not (Test-Path $file)) { return }
  $lines = [IO.File]::ReadAllLines($file)
  $changed = $false
  for ($i = 0; $i -lt $lines.Length; $i++) {
    foreach ($n in $names) {
      if ($lines[$i] -match "^\s*$n\s*=\s*\S") { $lines[$i] = "$n="; $changed = $true }
    }
  }
  if ($changed) {
    try {
      [IO.File]::WriteAllText($file, (($lines -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding $false))
      Good "Removed $($names -join ', ') from settings.txt (now saved securely)"
    } catch {
      Warn "Couldn't blank the keys in $file. Delete that file or remove the keys from it yourself."
    }
  }
}

function Is-Yes([string]$v) { return ($v -match '^\s*(y|yes|true|1|on)\s*$') }
function Is-No([string]$v) { return ($v -match '^\s*(n|no|false|0|off)\s*$') }

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
# settings.txt sits next to Setup.cmd (in the download or the install folder), or next to this script.
$SettingsFile = @((Join-Path (Split-Path $Source -Parent) "settings.txt"), (Join-Path $PSScriptRoot "settings.txt")) |
  Where-Object { Test-Path $_ } | Select-Object -First 1

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
  $st = Read-Settings $SettingsFile
  $auto = [bool]($st['DEVELOPER_KEY'] -or $st['CUSTOMER_KEY'] -or $st['LAB_SYNC'] -or $st['LAB_TRACKER_ADDRESS'] -or $st['SHARED_SECRET'])
  if ($auto) { Good "Using the answers in $SettingsFile" }
  $envMap = Read-EnvFile $EnvFile
  $current = Helper @("get", $Config)
  $keepAll = $false
  if (-not $auto -and $envMap['OD_DEVELOPER_KEY'] -and $current.exists) {
    $keepAll = AskYes "Keep all current settings and just update/restart?" $true
  }

  $keysFromFile = $false
  if ($auto) {
    $askKeys = $false
    $addr = if ($st['OPEN_DENTAL_ADDRESS']) { $st['OPEN_DENTAL_ADDRESS'] } elseif ($envMap['OD_BASE_URL']) { $envMap['OD_BASE_URL'] } else { "http://127.0.0.1:30223/api/v1" }
    $envMap['OD_BASE_URL'] = $addr
    if ($addr -match 'api\.opendental\.com') {
      $envMap['OD_API_PLAN'] = if ($st['API_PLAN']) { $st['API_PLAN'] } elseif ($envMap['OD_API_PLAN']) { $envMap['OD_API_PLAN'] } else { "standard" }
    } else { $envMap.Remove('OD_API_PLAN') }
    Good "Open Dental address: $addr"
    foreach ($pair in @(@("DEVELOPER_KEY", "OD_DEVELOPER_KEY", "Developer Key"), @("CUSTOMER_KEY", "OD_CUSTOMER_KEY", "Customer Key"))) {
      $fv = $st[$pair[0]]
      if ($fv) {
        $c = Clean-Key $fv
        if ($c -match '^[A-Za-z0-9_-]{4,128}$') { $envMap[$pair[1]] = $c; $keysFromFile = $true; Good "$($pair[2]) read from settings.txt" }
        else {
          Warn "$($pair[0]) in settings.txt doesn't look like an Open Dental key: it has $(Describe-Key $fv)."
          $envMap[$pair[1]] = AskKey $pair[2]
        }
      } elseif (-not $envMap[$pair[1]]) {
        $envMap[$pair[1]] = AskKey $pair[2]
      } else { Good "$($pair[2]): keeping the one saved before" }
    }
    Write-EnvFile $EnvFile $envMap
  } else {
    $askKeys = -not $envMap['OD_DEVELOPER_KEY']
    if (-not $keepAll -and -not $askKeys) { $askKeys = -not (AskYes "Keep the saved Open Dental keys and address ($($envMap['OD_BASE_URL']))?" $true) }
  }

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
      Say "   A small window opens for each key. Paste the key there and click OK."
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
  # The keys are saved in data\.env now; don't leave them in settings.txt.
  Scrub-Settings $SettingsFile @("DEVELOPER_KEY", "CUSTOMER_KEY")

  # ------------------------------------------------------------ 4. lab tracker sync

  Step "4/5  Lab tracker sync"
  $ls = $current.labSync
  $syncOn = $false
  $writeEnv = @{}
  $sendTest = $true
  if ($keepAll) {
    $syncOn = [bool]($ls -and $ls.enabled)
    Good $(if ($syncOn) { "Keeping the lab sync settings ($($ls.trackerUrl))" } else { "Lab sync stays off" })
  } elseif ($auto -and (Is-Yes $st['LAB_SYNC'])) {
    $syncOn = $true
  } elseif ($auto -and (Is-No $st['LAB_SYNC'])) {
    $syncOn = $false
    Good "Lab sync off (settings.txt)"
  } elseif ($auto -and -not $st['LAB_SYNC'] -and $st['LAB_TRACKER_ADDRESS']) {
    $syncOn = $true
  } elseif ($auto -and -not $st['LAB_SYNC'] -and $ls -and $ls.enabled) {
    $syncOn = $true
  } else {
    Say "   Sends new Open Dental lab cases to a web lab tracker (patient as 'J. Smith' only)"
    Say "   and writes 'ready' (and 'sent' for outside labs) back. See docs\lab-tracker-sync.md."
    $syncOn = AskYes "Set up the lab tracker sync?" ([bool]($ls -and $ls.enabled))
  }

  if ($syncOn -and -not $keepAll) {
    # Tracker address
    $url = if ($auto -and $st['LAB_TRACKER_ADDRESS']) { $st['LAB_TRACKER_ADDRESS'] } elseif ($auto -and $ls -and $ls.trackerUrl) { $ls.trackerUrl } else { "" }
    if ($url -and $url -notmatch '^https://[^/\s]+/.*od-sync\.php$') {
      Warn "LAB_TRACKER_ADDRESS should look like https://lab.example.com/od-sync.php"
      $url = ""
    }
    if ($url) { Good "Tracker: $url" }
    while (-not $url) {
      $url = Ask "Tracker sync address (ends in /od-sync.php)" $(if ($ls -and $ls.trackerUrl) { $ls.trackerUrl } else { "https://" })
      if ($url -notmatch '^https://[^/\s]+/.*od-sync\.php$') { Warn "It should look like https://lab.example.com/od-sync.php"; $url = "" }
    }

    # In-house labs
    $labs = Helper @("labs", $Config)
    $labNums = @()
    if ($labs.ok -and $labs.labs) {
      Say "   Labs in Open Dental:"
      foreach ($l in $labs.labs) { Say ("     {0,4}  {1}" -f $l.num, $l.name); $labNums += [string]$l.num }
    } else { Warn "Couldn't list labs: $($labs.error)" }
    $inHouse = $null
    if ($auto -and $st['IN_HOUSE_LABS']) {
      $inHouse = if ($st['IN_HOUSE_LABS'] -match '^\s*none\s*$') { "" } else { (($st['IN_HOUSE_LABS'] -split '[\s,]+') | Where-Object { $_ }) -join "," }
      $unknown = @(($inHouse -split ',') | Where-Object { $_ -and $labNums.Count -and ($labNums -notcontains $_) })
      if ($inHouse -and ($inHouse -notmatch '^\d+(,\d+)*$')) { Warn "IN_HOUSE_LABS should be numbers from the list above, or none."; $inHouse = $null }
      elseif ($unknown.Count) { Warn "IN_HOUSE_LABS has $($unknown -join ', '), which isn't in the list above."; $inHouse = $null }
    } elseif ($auto -and $ls) {
      $inHouse = [string]$ls.inHouseLabs
    }
    if ($null -eq $inHouse) {
      $inHouse = Ask "Number(s) of your in-house lab(s), separated by commas (blank if none)" $(if ($ls) { $ls.inHouseLabs } else { "" })
    } else {
      Good $(if ($inHouse) { "In-house lab(s): $inHouse" } else { "In-house labs: none" })
    }

    # Start date
    $today = (Get-Date).ToString("yyyy-MM-dd")
    $from = $null
    if ($auto) {
      $sd = $st['SYNC_START_DATE']
      if ($sd -and $sd -notmatch '^\s*today\s*$') { $from = $sd.Trim() }
      elseif ($ls -and $ls.syncFrom) { $from = $ls.syncFrom }
      else { $from = $today }
      $d = [datetime]::MinValue
      if (-not [datetime]::TryParseExact($from, "yyyy-MM-dd", $null, [Globalization.DateTimeStyles]::None, [ref]$d)) { Warn "SYNC_START_DATE should look like 2026-11-16 (or today)."; $from = $null }
      else { Good "Cases created on or after $from are sent" }
    }
    if (-not $from) {
      Say "   Only lab cases created on or after the start date are sent (so old cases don't flood the tracker)."
      while ($true) {
        $from = Ask "Start date (yyyy-MM-dd)" $(if ($ls -and $ls.syncFrom) { $ls.syncFrom } else { $today })
        $d = [datetime]::MinValue
        if ([datetime]::TryParseExact($from, "yyyy-MM-dd", $null, [Globalization.DateTimeStyles]::None, [ref]$d)) { break }
        Warn "Use the form 2026-11-16."
      }
    }

    # Patient format
    $fmt = $null
    if ($auto) {
      $pf = [string]$st['PATIENT_FORMAT']
      if ($pf -match '^\s*(J\.?\s*S\.?|initials)\s*$') { $fmt = "initials" }
      elseif ($pf -match '^\s*(J\.?\s+Smith|initial-last)\s*$') { $fmt = "initial-last" }
      elseif (-not $pf) { $fmt = if ($ls -and $ls.patientFormat) { $ls.patientFormat } else { "initial-last" } }
      else { Warn "PATIENT_FORMAT should be J. Smith or J.S." }
      if ($fmt) { Good $(if ($fmt -eq "initials") { "Patients shown as J.S." } else { "Patients shown as J. Smith" }) }
    }
    if (-not $fmt) {
      Say "   How patients appear in the tracker:  1 = J. Smith    2 = J.S."
      $fmtDefault = if ($ls -and $ls.patientFormat -eq "initials") { "2" } else { "1" }
      $fmt = if ((Ask "Choose 1 or 2" $fmtDefault) -eq "2") { "initials" } else { "initial-last" }
    }

    # Patient number (Open Dental's PatNum): only when asked for; otherwise keep what was saved.
    $patNum = if ($ls -and $ls.sendPatNum) { "1" } else { "0" }
    if ($auto -and $st['SEND_PATIENT_NUMBER']) {
      if (Is-No $st['SEND_PATIENT_NUMBER']) { $patNum = "0" }
      elseif ($st['SEND_PATIENT_NUMBER'] -match '^\s*(y|yes)\s*$') { $patNum = "1" }
      else { Warn "SEND_PATIENT_NUMBER should be yes or no; keeping the saved choice." }
    }
    if ($patNum -eq "1") { Good "Open Dental's patient number (PatNum) is sent with each case" }

    # Shared secret
    $newSecret = $false
    $fileSecret = if ($auto -and $st['SHARED_SECRET']) { Clean-Key $st['SHARED_SECRET'] } else { "" }
    if ($fileSecret -and $fileSecret -match '^[A-Za-z0-9_-]{32,}$') {
      $envMap['LAB_SYNC_SECRET'] = $fileSecret
      Write-EnvFile $EnvFile $envMap
      Good "Shared secret read from settings.txt (it must match OD_SYNC_SECRET in the tracker's config.php)"
      Scrub-Settings $SettingsFile @("SHARED_SECRET")
    } else {
      if ($fileSecret) { Warn "SHARED_SECRET in settings.txt is too short (at least 32 letters and numbers); ignoring it." }
      if (-not $envMap['LAB_SYNC_SECRET']) { $newSecret = $true }
      elseif ($auto) { Good "Keeping the shared secret saved before" }
      else { $newSecret = AskYes "Make a new shared secret? (No keeps the one already in the tracker)" $false }
    }
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

    if ($auto -and (Is-No $st['SEND_TEST'])) { $sendTest = $false }
    $writeEnv = @{ SETUP_LABSYNC = "1"; SETUP_TRACKER_URL = $url; SETUP_IN_HOUSE = $inHouse; SETUP_SYNC_FROM = $from; SETUP_PATIENT_FORMAT = $fmt; SETUP_SEND_PATNUM = $patNum }
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
      $doSend = if ($auto) { $sendTest } else { AskYes "Send to the tracker now and check it works?" $true }
      if ($doSend) {
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

  # Keep a copy of the answers (without keys) next to the installed Setup.cmd for next time.
  $installedSettings = Join-Path $InstallDir "settings.txt"
  if ($SettingsFile -and ([IO.Path]::GetFullPath($SettingsFile) -ine $installedSettings)) {
    $leftover = Read-Settings $SettingsFile
    if (-not ($leftover['DEVELOPER_KEY'] -or $leftover['CUSTOMER_KEY'] -or $leftover['SHARED_SECRET'])) {
      Copy-Item -Force $SettingsFile $installedSettings
    }
  } elseif (-not $SettingsFile -and -not (Test-Path $installedSettings)) {
    $template = Join-Path $AppDir "gateway\windows\settings.txt"
    if (Test-Path $template) { Copy-Item -Force $template $installedSettings }
  }

  Write-Host ""
  Write-Host "  Done." -ForegroundColor Green
  Say "  Log:              $LogDir\gateway.log"
  Say "  Change settings:  edit $InstallDir\settings.txt if you like, then run $InstallDir\Setup.cmd"
  Say "  Remove:           powershell -ExecutionPolicy Bypass -File `"$AppDir\gateway\windows\setup.ps1`" -Uninstall"
} catch {
  Write-Host ""
  Write-Host "  Setup stopped: $($_.Exception.Message)" -ForegroundColor Red
  Say "  Nothing in Open Dental was changed. Fix the problem and run Setup again."
}
Pause-End
