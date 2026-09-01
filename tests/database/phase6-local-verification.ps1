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
function Assert-One([object[]]$Results,[string]$Code,[string]$Label) {
  Assert-True ((@($Results | Where-Object ExitCode -eq 0)).Count -eq 1) "$Label success"
  $failure=@($Results | Where-Object ExitCode -ne 0)
  Assert-True ($failure.Count -eq 1 -and $failure[0].Output.Contains($Code)) "$Label conflict"
}

Assert-True ((& git branch --show-current).Trim() -eq "feature/launch-hardening-notifications-promos-media") "required branch"
Assert-True ((& docker ps --filter "name=^/$container$" --filter "status=running" --format "{{.Names}}" | Out-String).Trim() -eq $container) "local database"
if (-not $SkipReset) {
  $output = & npx supabase@latest db reset --local 2>&1
  Assert-True ($LASTEXITCODE -eq 0 -and ($output | Out-String).Contains("Finished supabase db reset")) "clean reset"
}

$assertions = Get-Content (Join-Path $PSScriptRoot "phase6-local-assertions.sql") -Raw | & docker exec -i $container psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres 2>&1
Assert-True ($LASTEXITCODE -eq 0 -and ($assertions | Out-String).Contains("PASS|phase6-promo-catalog-security-lifecycle")) "Phase 6 assertions"
Write-Output "PASS|phase6-promo-catalog-security-lifecycle"

$admin=Run-Query "select id from public.profiles where role in ('admin','super_admin') order by id limit 1"
$customers=@((Run-Query "select id from public.profiles where role='customer' order by id limit 1"),(Run-Query "select id from public.profiles where role='customer' order by id offset 1 limit 1"))
Assert-True ($customers[0] -and $customers[1]) "promo customers"

function Invoke-Race([string]$LimitColumns,[string]$ExpectedCode,[string]$PassLabel) {
  $tag=[guid]::NewGuid().ToString("N")
  $promo=[guid]::NewGuid()
  [void](Run-Query "insert into public.promo_codes(id,code,internal_name,active,discount_type,percent_off,$LimitColumns,max_uses_per_customer,status,created_by) values ('$promo','RACE-$tag','Race',true,'percentage',10,1,5,'active','$admin')")
  $sql=@()
  for($index=0;$index -lt 2;$index++) {
    $event="race-$tag-$index"
    $key=[guid]::NewGuid()
    $sql += "select order_id from public.skie_reserve_checkout_with_promo('$($customers[$index])','race-$index@local.invalid','Race Customer','$event','Race Event',10,'AUD',now()+interval '30 minutes','[{`"ticket_type_id`":`"ticket-$event`",`"name`":`"Ticket`",`"quantity`":1,`"unit_price_cents`":1000,`"capacity`":10,`"customer_limit`":10}]','[]',null,'RACE-$tag','$key',1)"
  }
  $jobs=@((Start-Query $sql[0]),(Start-Query $sql[1]))
  $results=@((Finish-Query $jobs[0]),(Finish-Query $jobs[1]))
  Assert-One $results $ExpectedCode $PassLabel
  Assert-True ((Run-Query "select count(*) from public.promo_redemptions where promo_code_id='$promo' and status='reserved'") -eq "1") "$PassLabel persisted"
  Write-Output "PASS|$PassLabel"
}

Invoke-Race "max_redemptions" "PROMO_REDEMPTION_LIMIT" "concurrency-15-promo-final-redemption"
Invoke-Race "max_discounted_ticket_units" "PROMO_TICKET_UNIT_LIMIT" "concurrency-16-promo-final-ticket-unit"
Write-Output "PASS|phase6-local-database-verification"
