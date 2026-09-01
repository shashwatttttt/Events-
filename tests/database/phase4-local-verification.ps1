param([switch]$SkipReset)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$container = "supabase_db_Skie-Events-Production"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $workspace

function Assert-True([bool]$Condition,[string]$Label) { if (-not $Condition) { throw "ASSERTION_FAILED:$Label" } }
function Run-Query([string]$Sql) {
  $output = $Sql | & docker exec -i $container psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres 2>&1
  if ($LASTEXITCODE -ne 0) { throw "DATABASE_QUERY_FAILED" }
  return ($output | Out-String).Trim()
}
function Start-Query([string]$Sql) {
  Start-Job -ScriptBlock {
    param($Container,$Query)
    $output = $Query | & docker exec -i $Container psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres 2>&1
    [pscustomobject]@{ExitCode=$LASTEXITCODE;Output=($output | Out-String).Trim()}
  } -ArgumentList $container,$Sql
}
function Finish-Query($Job) { [void](Wait-Job $Job); $value=Receive-Job $Job; Remove-Job $Job; return $value }

Assert-True ((& git branch --show-current).Trim() -eq "feature/launch-hardening-notifications-promos-media") "required branch"
Assert-True ((& docker ps --filter "name=^/$container$" --filter "status=running" --format "{{.Names}}" | Out-String).Trim() -eq $container) "local database"
if (-not $SkipReset) {
  $output = & npx supabase@latest db reset --local 2>&1
  Assert-True ($LASTEXITCODE -eq 0 -and ($output | Out-String).Contains("Finished supabase db reset")) "clean reset"
}

$assertions = Get-Content (Join-Path $PSScriptRoot "phase4-local-assertions.sql") -Raw | & docker exec -i $container psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres 2>&1
Assert-True ($LASTEXITCODE -eq 0 -and ($assertions | Out-String).Contains("PASS|phase4-notification-catalog-security-behavior")) "Phase 4 assertions"
Write-Output "PASS|phase4-notification-catalog-security-behavior"

$tag = [guid]::NewGuid().ToString("N")
[void](Run-Query "select (public.skie_enqueue_notification('email','application_received',null,'phase4@local.invalid',repeat('b',64),null,null,'{}','phase4-$tag',3)).inserted")
$sql = "select coalesce((select id::text from public.skie_claim_notification_batch('email','worker-$tag',1,30) limit 1),'NONE')"
$first = Start-Query $sql
$second = Start-Query $sql
$results = @((Finish-Query $first),(Finish-Query $second))
Assert-True ((@($results | Where-Object ExitCode -eq 0)).Count -eq 2) "claim workers"
Assert-True ((@($results | Where-Object Output -eq "NONE")).Count -eq 1) "one empty worker"
Assert-True ((Run-Query "select attempt_count from public.notification_outbox where idempotency_key='phase4-$tag'") -eq "1") "single claim count"
Write-Output "PASS|concurrency-14-notification-batch-claim"
Write-Output "PASS|phase4-local-database-verification"
