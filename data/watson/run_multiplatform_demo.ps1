$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$databasePath = Join-Path $repoRoot "data\watson\data\products.demo-multiplatform.db"

if (-not (Test-Path -LiteralPath $databasePath -PathType Leaf)) {
  throw "Demo database not found: $databasePath"
}

Set-Location -LiteralPath $repoRoot
$env:PRODUCT_DATA_MODE = ""
$env:WATSONS_DB_PATH = $databasePath

Write-Host "Using multi-platform demo database: $databasePath"
Write-Host "Starting DeepSleep at http://localhost:3000"
npm run dev
