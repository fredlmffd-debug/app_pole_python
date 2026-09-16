$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$venvPython = Join-Path $projectRoot '.venv\Scripts\python.exe'

if (!(Test-Path $venvPython)) {
  Write-Error "Environnement virtuel introuvable ($venvPython). Executez d'abord : python -m venv .venv ; .venv\Scripts\pip install -e `".[dev]`""
}

Write-Host "[build-portable] Nettoyage build/dist..."
Remove-Item (Join-Path $projectRoot 'build') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $projectRoot 'dist\pole-scoring') -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[build-portable] Figeage de l'application avec PyInstaller..."
Push-Location $projectRoot
try {
  & $venvPython -m PyInstaller pole-scoring.spec --noconfirm
  if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller a echoue (code $LASTEXITCODE)"
  }
} finally {
  Pop-Location
}

Write-Host "[build-portable] Termine : dist\pole-scoring\pole-scoring.exe"
