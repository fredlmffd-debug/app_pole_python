$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

& (Join-Path $PSScriptRoot 'build-portable.ps1')

$programFilesX86 = ${env:ProgramFiles(x86)}
$isccCommand = Get-Command iscc.exe -ErrorAction SilentlyContinue

$isccCandidates = @(
  $(if ($isccCommand) { $isccCommand.Source }),
  'C:\Tools\InnoSetup\ISCC.exe',
  $(if ($programFilesX86) { Join-Path $programFilesX86 'Inno Setup 6\ISCC.exe' }),
  $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe' })
) | Where-Object { $_ -and (Test-Path $_) }

$iscc = $isccCandidates | Select-Object -First 1

if (-not $iscc) {
  Write-Warning "[build-installer] Inno Setup (ISCC.exe) introuvable sur ce poste."
  Write-Warning "[build-installer] Le dossier portable dist\pole-scoring est pret, mais l'installateur .exe n'a pas ete genere."
  exit 0
}

$installerDir = Join-Path $projectRoot 'dist\installer'
New-Item -ItemType Directory -Path $installerDir -Force | Out-Null

Write-Host "[build-installer] Nettoyage des anciens installateurs..."
Get-ChildItem $installerDir -Filter '*.exe' -ErrorAction SilentlyContinue | Remove-Item -Force

Write-Host "[build-installer] Compilation avec Inno Setup ($iscc)..."
& $iscc (Join-Path $projectRoot 'installer\pole-scoring.iss')
if ($LASTEXITCODE -ne 0) {
  throw "Inno Setup a echoue (code $LASTEXITCODE)"
}

Write-Host "[build-installer] Termine : dist\installer\pole-scoring-setup.exe"
