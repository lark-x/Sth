param(
  [Parameter(Mandatory = $true)][string]$Directory
)
$ErrorActionPreference = 'Stop'
if (![IO.Path]::IsPathRooted($Directory)) { throw 'Supply an absolute isolated binary directory.' }
$Directory = [IO.Path]::GetFullPath($Directory)
if (Test-Path -LiteralPath $Directory) { throw 'Choose a new isolated binary directory.' }
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$platform = switch ($arch) {
  'AMD64' { 'windows_amd64' }
  'ARM64' { 'windows_arm64' }
  default { throw 'Unsupported Windows architecture.' }
}
# The official bootstrap at https://antigravity.google/cli/install.ps1 names
# this updater. Download the signed payload directly to avoid its PATH/shell
# setup and its automatic `agy install` handoff.
$base = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app'
$manifest = Invoke-RestMethod -Uri "$base/manifests/$platform.json"
$url = [Uri]$manifest.url
if ($url.Scheme -ne 'https' -or $url.Host -ne 'storage.googleapis.com' -or !$url.AbsolutePath.StartsWith('/antigravity-public/antigravity-cli/')) {
  throw 'The official release manifest returned an unexpected download origin.'
}
if ($manifest.sha512 -notmatch '^[0-9a-fA-F]{128}$') { throw 'Invalid official SHA-512 manifest.' }
New-Item -ItemType Directory -Path $Directory | Out-Null
$staged = Join-Path $Directory 'agy.pending.exe'
$binary = Join-Path $Directory 'agy.exe'
try {
  Invoke-WebRequest -Uri $url.AbsoluteUri -OutFile $staged
  if ((Get-FileHash -LiteralPath $staged -Algorithm SHA512).Hash -ne $manifest.sha512) { throw 'Official SHA-512 verification failed.' }
  $signature = Get-AuthenticodeSignature -LiteralPath $staged
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|, )O=Google LLC(,|$)') {
    throw 'The CLI requires a valid Google LLC Authenticode signature.'
  }
  Move-Item -LiteralPath $staged -Destination $binary
  [pscustomobject]@{ executable = $binary; version = $manifest.version; sha512 = $manifest.sha512; signature = 'Google LLC' } | ConvertTo-Json
} finally {
  if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Force }
}
