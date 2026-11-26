param(
  [Parameter(Mandatory = $true)][string]$Binding,
  [Parameter(Mandatory = $true)][string]$ProjectDirectory,
  [string]$ProjectTitle = 'MyGame',
  [string]$State,
  [string]$Log
)

$ErrorActionPreference = 'Stop'
$syncScript = Join-Path $PSScriptRoot 'sync-codex-conversations.mjs'
$arguments = @(
  $syncScript,
  '--binding', $Binding,
  '--cwd', $ProjectDirectory,
  '--project-title', $ProjectTitle
)
if ($State) { $arguments += @('--state', $State) }
if ($Log) { $arguments += @('--log', $Log) }

& node @arguments
exit $LASTEXITCODE
