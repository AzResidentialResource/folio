# Publishes the app files in this folder to GitHub Pages.
# The git history is kept OUTSIDE OneDrive (in your user folder), so no .git folder syncs.
# Usage (PowerShell):  .\deploy.ps1 -Message "what changed"
param([string]$Message = "Update app")

$work = $PSScriptRoot
$gitDir = Join-Path $env:USERPROFILE ".folio-git"
$remote = "https://github.com/AzResidentialResource/folio.git"

function g { git --git-dir="$gitDir" --work-tree="$work" @args }

if (-not (Test-Path $gitDir)) {
  git init --bare "$gitDir" | Out-Null
  g config core.bare false
  g config core.autocrlf false
  g config user.name "Jon Jensen"
  g config user.email "AzResidentialResource@users.noreply.github.com"
  g remote add origin $remote
  g checkout -b main 2>$null
}

g add -A
g commit -m $Message
g push -u origin main
