$ErrorActionPreference = "Stop"
npm audit --omit=dev
npm run lint
npm run typecheck
npm run build
Write-Host "Verification passed." -ForegroundColor Green
