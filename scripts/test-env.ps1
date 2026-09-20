# Dot-source before tests, builds or packaging so that every temp directory, cache and test workspace is on E:.
#   . .\scripts\test-env.ps1; npm test
# Only this PowerShell session and its children are affected; Windows and npm settings stay unchanged.
param([string]$Root = 'E:\Project\codeagent-test-data')
foreach ($directory in 'temp', 'npm-cache', 'electron-cache', 'electron-builder-cache') { New-Item -ItemType Directory -Force (Join-Path $Root $directory) | Out-Null }
$env:TEMP = Join-Path $Root 'temp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $Root 'npm-cache'
$env:ELECTRON_CACHE = Join-Path $Root 'electron-cache'
$env:ELECTRON_BUILDER_CACHE = Join-Path $Root 'electron-builder-cache'
