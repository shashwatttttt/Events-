param([switch]$SkipReset)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$expectedBranch = "feature/launch-hardening-notifications-promos-media"
$container = "supabase_db_Skie-Events-Production"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $workspace

function Assert-True {
  param([bool]$Condition,[string]$Label)
  if (-not $Condition) { throw "ASSERTION_FAILED:$Label" }
}

function Start-DatabaseQuery {
  param([string]$Sql)
  return Start-Job -ScriptBlock {
    param([string]$ContainerName,[string]$Query)
    $output = $Query | & docker exec -i $ContainerName psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres 2>&1
    [pscustomobject]@{ ExitCode=$LASTEXITCODE; Output=($output | Out-String).Trim() }
  } -ArgumentList $container,$Sql
}

function Complete-DatabaseQuery {
  param([System.Management.Automation.Job]$Job)
  [void](Wait-Job $Job)
  $result = Receive-Job $Job
  Remove-Job $Job
  return $result
}

function Invoke-DatabaseQuery {
  param([string]$Sql)
  $result = Complete-DatabaseQuery (Start-DatabaseQuery $Sql)
  if ($result.ExitCode -ne 0) { throw "DATABASE_QUERY_FAILED" }
  return $result.Output
}

$branch = (& git branch --show-current).Trim()
Assert-True ($branch -eq $expectedBranch) "required branch"
$engine = & docker info --format "{{.ServerVersion}}" 2>$null
Assert-True ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace(($engine | Out-String))) "Docker engine"
$running = & docker ps --filter "name=^/$container$" --filter "status=running" --format "{{.Names}}"
Assert-True (($running | Out-String).Trim() -eq $container) "local Supabase database container"

if (-not $SkipReset) {
  $previousErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $resetOutput = & npx supabase@latest db reset --local 2>&1
  $resetExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorPreference
  Assert-True ($resetExitCode -eq 0) "clean local reset"
  Assert-True (($resetOutput | Out-String).Contains("Finished supabase db reset")) "clean local reset completion"
}

$assertionOutput = Get-Content (Join-Path $PSScriptRoot "phase3-local-assertions.sql") -Raw |
  & docker exec -i $container psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres 2>&1
Assert-True ($LASTEXITCODE -eq 0) "Phase 3 assertion SQL"
Assert-True (($assertionOutput | Out-String).Contains("PASS|phase3-catalog-security-state-staff-rate-limit")) "Phase 3 assertion marker"
Write-Output "PASS|phase3-catalog-security-state-staff-rate-limit"

$admin = [guid]::NewGuid()
$door = [guid]::NewGuid()
$setupSql = @"
insert into auth.users(id,email,raw_user_meta_data,created_at,updated_at) values
  ('$admin','$($admin.ToString('N'))@local.invalid','{"first_name":"Admin"}',now(),now()),
  ('$door','$($door.ToString('N'))@local.invalid','{"first_name":"Door"}',now(),now());
update public.profiles set role=case when id='$admin' then 'admin'::public.user_role else 'door_staff'::public.user_role end where id in ('$admin','$door');
select 'OK';
"@
Assert-True ((Invoke-DatabaseQuery $setupSql) -eq "OK") "Phase 3 synthetic users"

$rateHash = ([guid]::NewGuid().ToString("N"))
$first = Start-DatabaseQuery "select allowed from public.skie_consume_rate_limit('$rateHash',1,60)"
$second = Start-DatabaseQuery "select allowed from public.skie_consume_rate_limit('$rateHash',1,60)"
$rateResults = @((Complete-DatabaseQuery $first),(Complete-DatabaseQuery $second))
Assert-True ((@($rateResults | Where-Object ExitCode -eq 0)).Count -eq 2) "rate limiter concurrent completion"
Assert-True ((@($rateResults | Where-Object Output -eq "t")).Count -eq 1) "rate limiter one allowed"
Assert-True ((@($rateResults | Where-Object Output -eq "f")).Count -eq 1) "rate limiter one rejected"
Assert-True ((Invoke-DatabaseQuery "select request_count from public.rate_limit_buckets where key_hash='$rateHash'") -eq "1") "rate limiter capped count"
Write-Output "PASS|concurrency-11-rate-limit-final-slot"

$cmsVersion = Invoke-DatabaseQuery "select version from public.platform_documents where key='site'"
$cmsFirst = Start-DatabaseQuery "select saved_version from public.skie_replace_site_document($cmsVersion,(select payload from public.platform_documents where key='site'),'$admin',gen_random_uuid())"
$cmsSecond = Start-DatabaseQuery "select saved_version from public.skie_replace_site_document($cmsVersion,(select payload from public.platform_documents where key='site'),'$admin',gen_random_uuid())"
$cmsResults = @((Complete-DatabaseQuery $cmsFirst),(Complete-DatabaseQuery $cmsSecond))
Assert-True ((@($cmsResults | Where-Object ExitCode -eq 0)).Count -eq 1) "CMS one concurrent save"
$cmsFailure = @($cmsResults | Where-Object ExitCode -ne 0)
Assert-True ($cmsFailure.Count -eq 1 -and $cmsFailure[0].Output.Contains("CMS_STALE_VERSION")) "CMS stale save rejection"
Assert-True ((Invoke-DatabaseQuery "select version from public.platform_documents where key='site'") -eq ([string]([int64]$cmsVersion + 1))) "CMS single version increment"
Write-Output "PASS|concurrency-12-cms-stale-save"

$eventId = Invoke-DatabaseQuery "select payload #>> '{events,0,id}' from public.platform_documents where key='site'"
$closeVersion = Invoke-DatabaseQuery "select version from public.platform_documents where key='site'"
$reservationKey = [guid]::NewGuid()
$closeSql = @"
begin;
select pg_advisory_xact_lock(hashtextextended('event:$eventId',0));
select pg_sleep(1);
select saved_version from public.skie_replace_site_document(
  $closeVersion,
  (select jsonb_set(jsonb_set(payload,'{events,0,visibility}','"hidden"'::jsonb),'{events,0,ticketMode}','"closed"'::jsonb) from public.platform_documents where key='site'),
  '$admin',gen_random_uuid()
);
commit;
"@
$closeJob = Start-DatabaseQuery $closeSql
Start-Sleep -Milliseconds 200
$reserveJob = Start-DatabaseQuery @"
select reservation_id from public.skie_reserve_checkout_v2(
  '$door','$($door.ToString('N'))@local.invalid','Local Customer','$eventId','Local Event',5,'AUD',now()+interval '30 minutes',
  '[{"ticket_type_id":"phase3-close-ticket","name":"Ticket","quantity":1,"unit_price_cents":1000,"capacity":5,"customer_limit":2}]','[]',null,0,'$reservationKey',1
)
"@
$closeResult = Complete-DatabaseQuery $closeJob
$reserveResult = Complete-DatabaseQuery $reserveJob
Assert-True ($closeResult.ExitCode -eq 0) "event close completion"
Assert-True ($reserveResult.ExitCode -ne 0 -and $reserveResult.Output.Contains("EVENT_SALES_CLOSED")) "event close wins blocked checkout"
Assert-True ((Invoke-DatabaseQuery "select count(*) from public.reservations where reservation_key='$reservationKey'") -eq "0") "event close created no reservation"
Write-Output "PASS|concurrency-13-event-close-checkout-lock"

Write-Output "PASS|phase3-local-database-verification"
