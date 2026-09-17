param(
  [string]$NodeUrl = "http://127.0.0.1:4380",
  [string]$PythonUrl = "http://127.0.0.1:4390"
)

$ErrorActionPreference = 'Stop'

# Utilise l'API deja existante des deux cotes (identique Node/Python, testee
# en Phase 5 du portage) plutot qu'une copie de fichier a la main :
#   GET  /api/db/export  -> checkpoint WAL + snapshot .sqlite coherent, meme
#                            pendant que Node tourne et ecrit
#   POST /api/db/import  -> remplace entierement la base cible (ATTACH
#                            DATABASE, colonnes communes) et regenere les
#                            grilles de notation par defaut si besoin
#
# Les DEUX serveurs doivent etre demarres avant d'executer ce script.

Write-Host "[import-node-database] Export depuis Node ($NodeUrl)..."
$tempFile = [System.IO.Path]::GetTempFileName()

try {
  Invoke-WebRequest -Uri "$NodeUrl/api/db/export" -OutFile $tempFile -UseBasicParsing

  $sizeKb = [math]::Round((Get-Item $tempFile).Length / 1KB, 1)
  Write-Host "[import-node-database] Export recupere ($sizeKb Ko)."

  Write-Host "[import-node-database] Import dans Python ($PythonUrl) - remplace entierement la base cible..."
  $bytes = [System.IO.File]::ReadAllBytes($tempFile)
  $response = Invoke-WebRequest -Uri "$PythonUrl/api/db/import" -Method Post -Body $bytes -ContentType "application/octet-stream" -UseBasicParsing

  Write-Host "[import-node-database] Termine."
  Write-Host $response.Content
} finally {
  Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
}
