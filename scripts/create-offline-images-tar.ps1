Param()

$ErrorActionPreference = 'Stop'

$RootDir = Split-Path -Parent $PSScriptRoot
$ImgDir = Join-Path $RootDir 'docker-images'
$ComposeFile = Join-Path $ImgDir 'docker-compose.yml'
$OutTar = Join-Path $ImgDir 'evigstudio-offline-images.tar'

if (!(Test-Path $ComposeFile)) {
  throw "Missing compose file: $ComposeFile"
}

Write-Host "[1/3] Loading any existing docker-images/*.tar (if any)..."
if (Test-Path $ImgDir) {
  $tars = Get-ChildItem -Path $ImgDir -Filter *.tar -File
  foreach ($f in $tars) {
    if ($f.FullName -ieq $OutTar) { continue }
    Write-Host "  - docker load -i $($f.Name)"
    docker load -i $f.FullName | Out-Null
  }
}

Write-Host "[2/3] Collecting image names from docker-images/docker-compose.yml..."
$images = @(
  Select-String -Path $ComposeFile -Pattern '^\s*image\s*:\s*(.+)\s*$' |
    ForEach-Object {
      $v = $_.Matches[0].Groups[1].Value.Trim()
      $v = $v.Trim('"').Trim("'")
      if ($v) { $v }
    } |
    Sort-Object -Unique
)

if ($images.Count -eq 0) {
  throw "No images found in $ComposeFile"
}

Write-Host "Images:"
foreach ($img in $images) {
  Write-Host "  - $img"
}

Write-Host "[3/3] Saving single bundle tar -> $OutTar"
docker save -o $OutTar @images

Write-Host "Bundle created: $OutTar"
