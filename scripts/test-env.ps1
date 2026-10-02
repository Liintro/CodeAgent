# Dot-source before tests, builds or packaging so that every temp directory, cache and test workspace is on E:.
#   . .\scripts\test-env.ps1; npm test
# Only this PowerShell session and its children are affected; Windows and npm settings stay unchanged.
param([string]$Root = 'E:\Project\codeAgent-workspace\test-data', [string]$Toolchains = 'E:\Tools\codeagent-toolchains', [string]$Keil = 'D:\Keil5 MDK')
foreach ($directory in 'temp', 'npm-cache', 'electron-cache', 'electron-builder-cache', 'appdata', 'go', 'cargo-target') { New-Item -ItemType Directory -Force (Join-Path $Root $directory) | Out-Null }
$env:TEMP = Join-Path $Root 'temp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $Root 'npm-cache'
$env:ELECTRON_CACHE = Join-Path $Root 'electron-cache'
$env:ELECTRON_BUILDER_CACHE = Join-Path $Root 'electron-builder-cache'
# Go keeps telemetry and its env file under %APPDATA%; tests that copy the real ledger read CODEAGENT_USER_APPDATA instead.
if (-not $env:CODEAGENT_USER_APPDATA) { $env:CODEAGENT_USER_APPDATA = $env:APPDATA }
$env:APPDATA = Join-Path $Root 'appdata'
$env:GOCACHE = Join-Path $Root 'go\cache'
$env:GOMODCACHE = Join-Path $Root 'go\mod'
$env:GOPATH = Join-Path $Root 'go\path'
$env:GOTOOLCHAIN = 'local'
$env:RUSTUP_HOME = Join-Path $Toolchains 'rust\rustup'
$env:CARGO_HOME = Join-Path $Toolchains 'rust\cargo'
# Pinned toolchains installed on E: (see doc/Batch5_Execution_and_Acceptance_Report.md); prepended for this session only.
$paths = 'cmake-4.4.5\bin', 'winlibs-gcc-16.2.0\bin', 'go1.27.3\bin', 'rust\cargo\bin' | ForEach-Object { Join-Path $Toolchains $_ }
# The existing Keil MDK install (not installed by this project): UV4 and ARMCC.
$paths = @($paths) + @(Join-Path $Keil 'UV4') + @(Join-Path $Keil 'ARM\ARMCC\bin') | Where-Object { Test-Path $_ }
if ($paths) { $env:PATH = (@($paths) + ($env:PATH -split ';' | Where-Object { $_ -and ($paths -notcontains $_) })) -join ';' }
