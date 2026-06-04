$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

$directories = @(
  (Join-Path $HOME '.pi\agent\extensions'),
  (Join-Path $HOME '.agent-browser')
)
New-Item -ItemType Directory -Force -Path $directories | Out-Null

function Backup-Copy {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  if (Test-Path -LiteralPath $Destination -PathType Leaf) {
    Copy-Item -LiteralPath $Destination -Destination "$Destination.$Stamp.bak" -Force
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Invoke-OptionalCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $resolved = Get-Command $Command -ErrorAction SilentlyContinue
  if (-not $resolved) {
    Write-Warning "$Command not found; skipped: $Command $($Arguments -join ' ')"
    return
  }

  & $resolved.Source @Arguments
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "$Command $($Arguments -join ' ') exited with code $LASTEXITCODE; continuing."
    $global:LASTEXITCODE = 0
  }
}

function ConvertTo-Hashtable {
  param([Parameter(ValueFromPipeline = $true)]$InputObject)

  process {
    if ($null -eq $InputObject) {
      return $null
    }

    if ($InputObject -is [System.Collections.IDictionary]) {
      $hash = @{}
      foreach ($key in $InputObject.Keys) {
        $hash[$key] = ConvertTo-Hashtable -InputObject ($InputObject[$key])
      }
      return $hash
    }

    if ($InputObject -is [System.Collections.IEnumerable] -and $InputObject -isnot [string]) {
      $items = @()
      foreach ($item in $InputObject) {
        $items += ConvertTo-Hashtable -InputObject $item
      }
      return $items
    }

    if ($InputObject -is [pscustomobject]) {
      $hash = @{}
      foreach ($property in $InputObject.PSObject.Properties) {
        $hash[$property.Name] = ConvertTo-Hashtable -InputObject $property.Value
      }
      return $hash
    }

    return $InputObject
  }
}

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Text
  )

  $encoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
  [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

Backup-Copy (Join-Path $Root 'configs\pi\AGENTS.md') (Join-Path $HOME '.pi\agent\AGENTS.md')

$appendSystemSource = Join-Path $Root 'configs\pi\APPEND_SYSTEM.md'
$appendSystemDestination = Join-Path $HOME '.pi\agent\APPEND_SYSTEM.md'
if (Test-Path -LiteralPath $appendSystemDestination -PathType Leaf) {
  Copy-Item -LiteralPath $appendSystemDestination -Destination "$appendSystemDestination.$Stamp.bak" -Force
}
$appendSystemText = Get-Content -LiteralPath $appendSystemSource -Raw
$appendSystemText = $appendSystemText -replace "(?ms)\r?\n## sudo-gate\r?\n.*$", ""
Write-Utf8NoBom $appendSystemDestination ($appendSystemText.TrimEnd() + "`n")

Backup-Copy (Join-Path $Root 'configs\pi\web-search.json') (Join-Path $HOME '.pi\web-search.json')
Backup-Copy (Join-Path $Root 'configs\pi\extensions\pi-footer.ts') (Join-Path $HOME '.pi\agent\extensions\pi-footer.ts')
Backup-Copy (Join-Path $Root 'configs\agent-browser\config.json') (Join-Path $HOME '.agent-browser\config.json')

# Install/update the Pi packages this setup expects. `pi install` is idempotent for already-installed packages.
# pithagoras is added to settings below with sudo-gate filtered out on Windows.
Invoke-OptionalCommand 'pi' @('install', 'npm:pi-resource-center')
Invoke-OptionalCommand 'pi' @('install', 'npm:pi-web-access')
Invoke-OptionalCommand 'pi' @('install', 'npm:@aliou/pi-guardrails')

# Install agent-browser and its Agent Skill. The skill is a stable stub that loads version-matched usage docs from the CLI.
Invoke-OptionalCommand 'bun' @('install', '-g', 'agent-browser')
Invoke-OptionalCommand 'bunx' @('skills', 'add', 'vercel-labs/agent-browser', '-g', '--skill', 'agent-browser', '--agent', '*', '-y')

$srcSettings = Join-Path $Root 'configs\pi\settings.json'
$dstSettings = Join-Path $HOME '.pi\agent\settings.json'

$base = @{}
if (Test-Path -LiteralPath $dstSettings -PathType Leaf) {
  $existingText = Get-Content -LiteralPath $dstSettings -Raw
  if ($existingText.Trim().Length -gt 0) {
    $base = ConvertTo-Hashtable ($existingText | ConvertFrom-Json)
  }
}

$setup = ConvertTo-Hashtable ((Get-Content -LiteralPath $srcSettings -Raw) | ConvertFrom-Json)
$pithagorasSource = 'git:github.com/NihilDigit/pithagoras'
$pithagorasWindowsPackage = @{
  source = $pithagorasSource
  extensions = @('extensions/pithagoras/index.ts')
}

function Get-PackageSource {
  param($Package)

  if ($Package -is [string]) {
    return $Package
  }
  if ($Package -is [System.Collections.IDictionary] -and $Package.ContainsKey('source')) {
    return $Package['source']
  }
  return $null
}

$packages = @()
if ($base.ContainsKey('packages') -and $null -ne $base['packages']) {
  foreach ($package in @($base['packages'])) {
    $source = Get-PackageSource $package
    if ($package -eq $Root -or $source -eq $pithagorasSource) {
      continue
    }
    $packages += $package
  }
}

foreach ($package in @($setup['packages'])) {
  $candidate = $package
  $source = Get-PackageSource $package
  if ($source -eq $pithagorasSource) {
    $candidate = $pithagorasWindowsPackage
    $source = $pithagorasSource
  }

  $alreadyPresent = $false
  foreach ($existing in $packages) {
    if ((Get-PackageSource $existing) -eq $source) {
      $alreadyPresent = $true
      break
    }
  }

  if (-not $alreadyPresent) {
    $packages += $candidate
  }
}

$base['packages'] = $packages
Write-Utf8NoBom $dstSettings (($base | ConvertTo-Json -Depth 20) + "`n")

# Reconcile packages after writing the Windows filter for pithagoras.
Invoke-OptionalCommand 'pi' @('update', '--extensions')

Write-Host 'Applied pithagoras setup. Restart or /reload Pi to pick up resource changes.'
