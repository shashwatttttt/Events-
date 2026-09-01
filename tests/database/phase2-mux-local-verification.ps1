param([switch]$SkipReset)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) { $PSNativeCommandUseErrorActionPreference = $false }
$container = "supabase_db_Skie-Events-Production"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $workspace

function Assert-True([bool]$Condition,[string]$Label) { if (-not $Condition) { throw "ASSERTION_FAILED:$Label" } }
Assert-True ((& git branch --show-current).Trim() -eq "feature/launch-hardening-notifications-promos-media") "required branch"
Assert-True ((& docker ps --filter "name=^/$container$" --filter "status=running" --format "{{.Names}}" | Out-String).Trim() -eq $container) "local database"
if (-not $SkipReset) {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $output = & npx supabase@latest db reset --local 2>&1
  $resetExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
  Assert-True ($resetExitCode -eq 0 -and ($output | Out-String).Contains("Finished supabase db reset")) "clean reset with Phase 1 and Phase 2 migrations"
}
$assertions = Get-Content (Join-Path $PSScriptRoot "phase2-mux-local-assertions.sql") -Raw | & docker exec -i $container psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres 2>&1
Assert-True ($LASTEXITCODE -eq 0 -and ($assertions | Out-String).Contains("PASS|phase2-mux-video-security-lifecycle")) "Phase 2 Mux assertions"
Write-Output "PASS|phase2-mux-video-security-lifecycle"
