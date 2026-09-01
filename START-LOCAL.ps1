$ErrorActionPreference = "Stop"
if (-not (Test-Path ".env.local")) { throw "Run .\SETUP.ps1 first." }
npm run dev
