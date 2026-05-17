Param(
  [switch]$Up
)

$ErrorActionPreference = 'Stop'

$RootDir = Split-Path -Parent $PSScriptRoot
$ImgDir = Join-Path $RootDir 'docker-images'
$ComposeFile = Join-Path $ImgDir 'docker-compose.yml'
$Tar = Join-Path $ImgDir 'evigstudio-offline-images.tar'

if (Test-Path $Tar) {
  Write-Host "Loading bundle tar: $Tar"
  docker load -i $Tar
} else {
  Write-Host "Bundle tar not found ($Tar). Loading all per-image tarballs in $ImgDir ..."
  $tars = Get-ChildItem -Path $ImgDir -Filter *.tar -File
  if ($tars.Count -eq 0) {
    throw "No tarballs found in $ImgDir"
  }
  foreach ($f in $tars) {
    Write-Host "  - docker load -i $($f.Name)"
    docker load -i $f.FullName | Out-Null
  }
}

if ($Up) {
  Write-Host "Starting compose stack: $ComposeFile"
  docker compose -f $ComposeFile up -d
}
