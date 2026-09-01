param([switch]$SkipReset)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "phase2-local-verification.ps1") -SkipReset:$SkipReset
if ($LASTEXITCODE -ne 0) { throw "PHASE2_DATABASE_VERIFICATION_FAILED" }

& (Join-Path $PSScriptRoot "phase3-local-verification.ps1") -SkipReset
if ($LASTEXITCODE -ne 0) { throw "PHASE3_DATABASE_VERIFICATION_FAILED" }

& (Join-Path $PSScriptRoot "phase4-local-verification.ps1") -SkipReset
if ($LASTEXITCODE -ne 0) { throw "PHASE4_DATABASE_VERIFICATION_FAILED" }

& (Join-Path $PSScriptRoot "phase6-local-verification.ps1") -SkipReset
if ($LASTEXITCODE -ne 0) { throw "PHASE6_DATABASE_VERIFICATION_FAILED" }

& (Join-Path $PSScriptRoot "phase7-local-verification.ps1") -SkipReset
if ($LASTEXITCODE -ne 0) { throw "PHASE7_DATABASE_VERIFICATION_FAILED" }

& (Join-Path $PSScriptRoot "phase1-notifications-local-verification.ps1") -SkipReset
if ($LASTEXITCODE -ne 0) { throw "PHASE1_NOTIFICATIONS_DATABASE_VERIFICATION_FAILED" }

& (Join-Path $PSScriptRoot "phase2-mux-local-verification.ps1") -SkipReset
if ($LASTEXITCODE -ne 0) { throw "PHASE2_MUX_DATABASE_VERIFICATION_FAILED" }

& (Join-Path $PSScriptRoot "phase3-analytics-local-verification.ps1") -SkipReset
if ($LASTEXITCODE -ne 0) { throw "PHASE3_ANALYTICS_DATABASE_VERIFICATION_FAILED" }

& (Join-Path $PSScriptRoot "phase4-admin-tools-local-verification.ps1") -SkipReset
if ($LASTEXITCODE -ne 0) { throw "PHASE4_ADMIN_TOOLS_DATABASE_VERIFICATION_FAILED" }
