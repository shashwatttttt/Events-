$ErrorActionPreference = "Stop"

function New-HexSecret {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function Read-PlainSecureString([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is not installed. Install Node.js 20.9 or newer, then run this again."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is not available. Reinstall Node.js with npm enabled."
}

Write-Host "Installing dependencies..." -ForegroundColor Cyan
npm install

if (-not (Test-Path ".env.local")) {
  Copy-Item ".env.example" ".env.local"
  $adminEmail = Read-Host "Local admin email (press Enter for admin@skieevents.com)"
  if ([string]::IsNullOrWhiteSpace($adminEmail)) { $adminEmail = "admin@skieevents.com" }
  $adminPassword = Read-PlainSecureString "Choose a local admin password (minimum 10 characters)"
  if ($adminPassword.Length -lt 10) { throw "Admin password must contain at least 10 characters." }

  $content = Get-Content ".env.local" -Raw
  $content = $content -replace "AUTH_SECRET=.*", "AUTH_SECRET=$(New-HexSecret)"
  $content = $content -replace "TICKET_TOKEN_SECRET=.*", "TICKET_TOKEN_SECRET=$(New-HexSecret)"
  $content = $content -replace "ADMIN_EMAIL=.*", "ADMIN_EMAIL=$adminEmail"
  $content = $content -replace "ADMIN_PASSWORD=.*", "ADMIN_PASSWORD=$adminPassword"
  Set-Content ".env.local" $content -Encoding UTF8
  Write-Host ".env.local created. Never commit or share it." -ForegroundColor Green
} else {
  Write-Host ".env.local already exists; it was not overwritten." -ForegroundColor Yellow
}

New-Item -ItemType Directory -Force -Path "public/uploads" | Out-Null
npm run typecheck
Write-Host "Setup complete. Run .\START-LOCAL.ps1" -ForegroundColor Green
