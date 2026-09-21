param(
  [string]$Port = "4390",
  [string]$DataDir = "$PSScriptRoot\..\data-test"
)

$ErrorActionPreference = 'Stop'

# Lance la version Python sur un port isole, avec une base separee de la
# base "reelle" (celle utilisee par un lancement normal de l'app). Pense a
# demarrer la version Node en parallele si tu veux ensuite y importer ses
# donnees via scripts\import-node-database.ps1.

$env:APP_PORT = $Port
$env:POLE_SCORING_DATA_DIR = $DataDir

Write-Host "[run-test-mode] Port: $Port"
Write-Host "[run-test-mode] Donnees: $DataDir"

$venvPython = Join-Path $PSScriptRoot "..\.venv\Scripts\python.exe"
& $venvPython -m pole_scoring
