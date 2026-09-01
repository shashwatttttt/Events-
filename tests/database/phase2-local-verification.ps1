param(
  [switch]$SkipReset
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$expectedBranch = "feature/launch-hardening-notifications-promos-media"
$container = "supabase_db_Skie-Events-Production"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $workspace

function Assert-True {
  param([bool]$Condition, [string]$Label)
  if (-not $Condition) { throw "ASSERTION_FAILED:$Label" }
}

function Start-DatabaseQuery {
  param([string]$Sql)
  return Start-Job -ScriptBlock {
    param([string]$ContainerName, [string]$Query)
    $output = $Query | & docker exec -i $ContainerName psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres 2>&1
    [pscustomobject]@{
      ExitCode = $LASTEXITCODE
      Stdout = ($output | Out-String).Trim()
      Stderr = ($output | Out-String).Trim()
    }
  } -ArgumentList $container, $Sql
}

function Complete-DatabaseQuery {
  param([System.Management.Automation.Job]$Process)
  [void](Wait-Job $Process)
  $result = Receive-Job $Process
  Remove-Job $Process
  return $result
}

function Invoke-DatabaseQuery {
  param([string]$Sql)
  $result = Complete-DatabaseQuery (Start-DatabaseQuery $Sql)
  if ($result.ExitCode -ne 0) { throw "DATABASE_QUERY_FAILED" }
  return $result.Stdout
}

function Invoke-ExpectedDatabaseError {
  param([string]$Sql, [string]$ExpectedCode)
  $result = Complete-DatabaseQuery (Start-DatabaseQuery $Sql)
  Assert-True ($result.ExitCode -ne 0) "expected database rejection"
  Assert-True ($result.Stderr.Contains($ExpectedCode)) "expected rejection code $ExpectedCode"
}

function Invoke-ConcurrentPair {
  param([string]$FirstSql, [string]$SecondSql)
  $firstProcess = Start-DatabaseQuery $FirstSql
  $secondProcess = Start-DatabaseQuery $SecondSql
  $first = Complete-DatabaseQuery $firstProcess
  $second = Complete-DatabaseQuery $secondProcess
  return @($first, $second)
}

function Assert-OneSuccessOneConflict {
  param([object[]]$Results, [string]$ExpectedCode, [string]$Label)
  Assert-True ((@($Results | Where-Object ExitCode -eq 0)).Count -eq 1) "$Label success count"
  $failure = @($Results | Where-Object ExitCode -ne 0)
  Assert-True ($failure.Count -eq 1) "$Label conflict count"
  Assert-True ($failure[0].Stderr.Contains($ExpectedCode)) "$Label conflict code"
}

function New-ReservationSql {
  param(
    [guid]$CustomerId,
    [guid]$ReservationKey,
    [string]$EventId,
    [string]$TicketTypeId,
    [int]$EventCapacity,
    [int]$TicketCapacity,
    [string]$ProductId = "",
    [int]$ProductStock = 0
  )
  $email = "$($CustomerId.ToString('N'))@local.invalid"
  $products = "[]"
  if ($ProductId) {
    $products = "[{`"product_id`":`"$ProductId`",`"name`":`"Local Product`",`"quantity`":1,`"unit_price_cents`":500,`"stock_quantity`":$ProductStock,`"max_per_customer`":5,`"units_per_purchase`":1,`"redeemable`":true}]"
  }
  return @"
select 'OK' from public.skie_reserve_checkout(
  '$CustomerId','$email','Local Customer','$EventId','Local Event',$EventCapacity,'AUD',now() + interval '30 minutes',
  '[{"ticket_type_id":"$TicketTypeId","name":"Local Ticket","quantity":1,"unit_price_cents":1000,"capacity":$TicketCapacity,"customer_limit":5}]',
  '$products',null,0,'$ReservationKey',1
);
"@
}

function AttemptIdSql {
  param([guid]$ReservationKey)
  return "select attempt.id from public.checkout_attempts attempt join public.reservations reservation on reservation.id = attempt.reservation_id where reservation.reservation_key = '$ReservationKey'"
}

function ReservationIdSql {
  param([guid]$ReservationKey)
  return "select reservation.id from public.reservations reservation where reservation.reservation_key = '$ReservationKey'"
}

function OrderIdSql {
  param([guid]$ReservationKey)
  return "select ordered.id from public.orders ordered join public.reservations reservation on reservation.id = ordered.reservation_id where reservation.reservation_key = '$ReservationKey'"
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

$assertionOutput = Get-Content (Join-Path $PSScriptRoot "phase2-local-assertions.sql") -Raw |
  & docker exec -i $container psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres 2>&1
Assert-True ($LASTEXITCODE -eq 0) "catalog/RPC/role assertion SQL"
Assert-True (($assertionOutput | Out-String).Contains("PASS|catalog-security-rpc-role-scope")) "catalog/RPC/role assertion marker"
Write-Output "PASS|catalog-security-rpc-role-scope"

$runTag = ([guid]::NewGuid().ToString("N")).Substring(0, 12)
$customerA = [guid]::NewGuid()
$customerB = [guid]::NewGuid()
$door = [guid]::NewGuid()
$scanner = [guid]::NewGuid()
$admin = [guid]::NewGuid()
$superAdmin = [guid]::NewGuid()

$userSql = @"
insert into auth.users(id,email,raw_user_meta_data,created_at,updated_at) values
  ('$customerA','$($customerA.ToString('N'))@local.invalid','{"first_name":"Customer","last_name":"A"}',now(),now()),
  ('$customerB','$($customerB.ToString('N'))@local.invalid','{"first_name":"Customer","last_name":"B"}',now(),now()),
  ('$door','$($door.ToString('N'))@local.invalid','{"first_name":"Door"}',now(),now()),
  ('$scanner','$($scanner.ToString('N'))@local.invalid','{"first_name":"Scanner"}',now(),now()),
  ('$admin','$($admin.ToString('N'))@local.invalid','{"first_name":"Admin"}',now(),now()),
  ('$superAdmin','$($superAdmin.ToString('N'))@local.invalid','{"first_name":"Super"}',now(),now());
update public.profiles set role = case id
  when '$door' then 'door_staff'::public.user_role
  when '$scanner' then 'scanner_only'::public.user_role
  when '$admin' then 'admin'::public.user_role
  when '$superAdmin' then 'super_admin'::public.user_role
  else 'customer'::public.user_role end
where id in ('$customerA','$customerB','$door','$scanner','$admin','$superAdmin');
select 'OK';
"@
Assert-True ((Invoke-DatabaseQuery $userSql) -eq "OK") "synthetic users"

# 1. Two customers reserve the final ticket through simultaneous connections.
$ticketEvent = "$runTag-ticket"
$ticketType = "$runTag-tt"
$ticketKeyA = [guid]::NewGuid()
$ticketKeyB = [guid]::NewGuid()
$results = Invoke-ConcurrentPair `
  (New-ReservationSql $customerA $ticketKeyA $ticketEvent $ticketType 1 1) `
  (New-ReservationSql $customerB $ticketKeyB $ticketEvent $ticketType 1 1)
Assert-OneSuccessOneConflict $results "EVENT_CAPACITY_EXCEEDED" "final ticket"
Assert-True ((Invoke-DatabaseQuery "select count(*) from public.reservations where event_id = '$ticketEvent'") -eq "1") "final ticket persisted count"
Write-Output "PASS|concurrency-01-final-ticket"

# 2. Two customers reserve the final product through simultaneous connections.
$productEvent = "$runTag-product"
$productType = "$runTag-product-tt"
$productId = "$runTag-product-id"
$productKeyA = [guid]::NewGuid()
$productKeyB = [guid]::NewGuid()
$results = Invoke-ConcurrentPair `
  (New-ReservationSql $customerA $productKeyA $productEvent $productType 2 2 $productId 1) `
  (New-ReservationSql $customerB $productKeyB $productEvent $productType 2 2 $productId 1)
Assert-OneSuccessOneConflict $results "PRODUCT_STOCK_EXCEEDED" "final product"
Assert-True ((Invoke-DatabaseQuery "select count(*) from public.reservation_product_lines line join public.reservations reservation on reservation.id = line.reservation_id where reservation.event_id = '$productEvent'") -eq "1") "final product persisted count"
Write-Output "PASS|concurrency-02-final-product"

# 3. Two different Session IDs race to link one checkout attempt.
$sessionEvent = "$runTag-session"
$sessionKey = [guid]::NewGuid()
Assert-True ((Invoke-DatabaseQuery (New-ReservationSql $customerA $sessionKey $sessionEvent "$runTag-session-tt" 2 2)) -eq "OK") "session fixture"
$attemptLookup = AttemptIdSql $sessionKey
$sessionOne = "cs_${runTag}_one"
$sessionTwo = "cs_${runTag}_two"
$results = Invoke-ConcurrentPair `
  "select (public.skie_link_stripe_session(($attemptLookup),'$sessionOne',now() + interval '30 minutes')).stripe_checkout_session_id" `
  "select (public.skie_link_stripe_session(($attemptLookup),'$sessionTwo',now() + interval '30 minutes')).stripe_checkout_session_id"
Assert-OneSuccessOneConflict $results "CHECKOUT_SESSION_ALREADY_LINKED" "Session link"
Assert-True ((Invoke-DatabaseQuery "select count(*) from public.checkout_attempts where id = ($attemptLookup) and stripe_checkout_session_id in ('$sessionOne','$sessionTwo')") -eq "1") "Session link persisted count"
Write-Output "PASS|concurrency-03-session-link"

# 4. Duplicate paid webhook fulfilment creates one payment and exact quantities.
$paidEvent = "$runTag-paid"
$paidKey = [guid]::NewGuid()
$paidTicketId = [guid]::NewGuid()
$paidEntitlementId = [guid]::NewGuid()
$paidSession = "cs_${runTag}_paid"
$paidIntent = "pi_${runTag}_paid"
$paidWebhook = "evt_${runTag}_paid"
Assert-True ((Invoke-DatabaseQuery (New-ReservationSql $customerA $paidKey $paidEvent "$runTag-paid-tt" 2 2 "$runTag-paid-product" 2)) -eq "OK") "paid fixture"
$paidAttempt = AttemptIdSql $paidKey
Assert-True ((Invoke-DatabaseQuery "select (public.skie_link_stripe_session(($paidAttempt),'$paidSession',now() + interval '30 minutes')).status") -eq "session_active") "paid Session"
Assert-True ((Invoke-DatabaseQuery "select inserted from public.skie_record_stripe_webhook('$paidWebhook','checkout.session.completed',false,now(),null,'$paidSession','$paidSession','$paidIntent',null,null,null,gen_random_uuid())") -eq "t") "paid webhook inbox"
$paidOrder = OrderIdSql $paidKey
$paidReservation = ReservationIdSql $paidKey
$paidWorkTemplate = @'
do $$
declare
  reservation_value uuid := (__RESERVATION__);
  order_value uuid := (__ORDER__);
begin
  perform public.skie_record_payment_received('__WEBHOOK__','__SESSION__','__INTENT__',1500,'AUD',now(),order_value::text,order_value::text);
  perform public.skie_fulfil_payment(
    reservation_value,
    '[{"id":"__TICKET_ID__","ticket_type_id":"__TICKET_TYPE__","ticket_code":"__TICKET_CODE__","token_hash":"__TOKEN_HASH__","token_preview":"local","holder_name":"Local Customer"}]',
    '[{"id":"__ENTITLEMENT_ID__","product_id":"__PRODUCT_ID__","name":"Local Product","quantity_total":2}]'
  );
end;
$$;
select 'OK';
'@
$paidWork = $paidWorkTemplate.Replace("__RESERVATION__", $paidReservation).Replace("__ORDER__", $paidOrder).
  Replace("__WEBHOOK__", $paidWebhook).Replace("__SESSION__", $paidSession).Replace("__INTENT__", $paidIntent).
  Replace("__TICKET_ID__", $paidTicketId).Replace("__TICKET_TYPE__", "$runTag-paid-tt").
  Replace("__TICKET_CODE__", "LOCAL-$runTag-PAID").Replace("__TOKEN_HASH__", "local-$runTag-paid-token-hash-0000000000000000").
  Replace("__ENTITLEMENT_ID__", $paidEntitlementId).Replace("__PRODUCT_ID__", "$runTag-paid-product")
$results = Invoke-ConcurrentPair $paidWork $paidWork
Assert-True ((@($results | Where-Object ExitCode -eq 0)).Count -eq 2) "duplicate paid fulfilment completes"
$paidCounts = Invoke-DatabaseQuery "select (select count(*) from public.payments where stripe_payment_intent_id = '$paidIntent') || '|' || (select count(*) from public.tickets where id = '$paidTicketId') || '|' || (select count(*) from public.entitlements where id = '$paidEntitlementId') || '|' || (select quantity_total from public.entitlements where id = '$paidEntitlementId')"
Assert-True ($paidCounts -eq "1|1|1|2") "duplicate paid exact quantities"
Write-Output "PASS|concurrency-04-duplicate-paid-fulfilment"

# 5. A failure after committed payment evidence leaves a paid_unfulfilled order.
$failureEvent = "$runTag-failure"
$failureKey = [guid]::NewGuid()
$failureSession = "cs_${runTag}_failure"
$failureIntent = "pi_${runTag}_failure"
$failureWebhook = "evt_${runTag}_failure"
Assert-True ((Invoke-DatabaseQuery (New-ReservationSql $customerA $failureKey $failureEvent "$runTag-failure-tt" 2 2 "$runTag-failure-product" 1)) -eq "OK") "failure fixture"
$failureAttempt = AttemptIdSql $failureKey
$failureOrder = OrderIdSql $failureKey
$failureReservation = ReservationIdSql $failureKey
[void](Invoke-DatabaseQuery "select (public.skie_link_stripe_session(($failureAttempt),'$failureSession',now() + interval '30 minutes')).status")
[void](Invoke-DatabaseQuery "select inserted from public.skie_record_stripe_webhook('$failureWebhook','checkout.session.completed',false,now(),null,'$failureSession','$failureSession','$failureIntent',null,null,null,gen_random_uuid())")
Assert-True ((Invoke-DatabaseQuery "select failure_code is null from public.skie_record_payment_received('$failureWebhook','$failureSession','$failureIntent',1500,'AUD',now(),($failureOrder)::text,($failureOrder)::text)") -eq "t") "failure payment evidence"
Invoke-ExpectedDatabaseError "select * from public.skie_fulfil_payment(($failureReservation),'[]','[]')" "TICKET_COUNT_MISMATCH"
[void](Invoke-DatabaseQuery "select public.skie_mark_paid_unfulfilled(($failureReservation),'FORCED_LOCAL_FAILURE')")
$failureState = Invoke-DatabaseQuery "select (select count(*) from public.payments where stripe_payment_intent_id = '$failureIntent') || '|' || (select status from public.orders where id = ($failureOrder))"
Assert-True ($failureState -eq "1|paid_unfulfilled") "payment survives forced failure"
Write-Output "PASS|concurrency-05-payment-evidence-survives"

# 6. Simultaneous paid_unfulfilled retries remain idempotent.
$retryTicketId = [guid]::NewGuid()
$retryEntitlementId = [guid]::NewGuid()
$retryTemplate = @'
select duplicate from public.skie_fulfil_payment(
  (__RESERVATION__),
  '[{"id":"__TICKET_ID__","ticket_type_id":"__TICKET_TYPE__","ticket_code":"__TICKET_CODE__","token_hash":"__TOKEN_HASH__","token_preview":"local","holder_name":"Local Customer"}]',
  '[{"id":"__ENTITLEMENT_ID__","product_id":"__PRODUCT_ID__","name":"Local Product","quantity_total":1}]'
);
'@
$retrySql = $retryTemplate.Replace("__RESERVATION__", $failureReservation).Replace("__TICKET_ID__", $retryTicketId).
  Replace("__TICKET_TYPE__", "$runTag-failure-tt").Replace("__TICKET_CODE__", "LOCAL-$runTag-RETRY").
  Replace("__TOKEN_HASH__", "local-$runTag-retry-token-hash-00000000000000").Replace("__ENTITLEMENT_ID__", $retryEntitlementId).
  Replace("__PRODUCT_ID__", "$runTag-failure-product")
$results = Invoke-ConcurrentPair $retrySql $retrySql
Assert-True ((@($results | Where-Object ExitCode -eq 0)).Count -eq 2) "paid unfulfilled retry completion"
$retryCounts = Invoke-DatabaseQuery "select (select count(*) from public.tickets where order_id = ($failureOrder)) || '|' || (select count(*) from public.entitlements where order_id = ($failureOrder)) || '|' || (select status from public.orders where id = ($failureOrder))"
Assert-True ($retryCounts -eq "1|1|fulfilled") "paid unfulfilled retry exact quantities"
Write-Output "PASS|concurrency-06-paid-unfulfilled-retry"

# Assign event-scoped local staff only after the order exists.
[void](Invoke-DatabaseQuery "insert into public.event_staff_assignments(user_id,event_id,role,assigned_by) values ('$scanner','$failureEvent','scanner_only','$admin'),('$door','$failureEvent','door_staff','$admin'); select 'OK'")

# 7. Two simultaneous scans yield valid plus already_checked_in.
$scanSql = "select result from public.skie_check_in('$retryTicketId','local-$runTag-retry-token-hash-00000000000000','$failureEvent','$scanner','')"
$results = Invoke-ConcurrentPair $scanSql $scanSql
Assert-True ((@($results | Where-Object ExitCode -eq 0)).Count -eq 2) "scan completion"
$scanResults = @($results | ForEach-Object Stdout | Sort-Object)
Assert-True (($scanResults -join "|") -eq "already_checked_in|valid") "scan outcomes"
Assert-True ((Invoke-DatabaseQuery "select count(*) from public.check_ins where ticket_id = '$retryTicketId' and result in ('valid','already_checked_in')") -eq "2") "scan audit count"
Write-Output "PASS|concurrency-07-qr-scan"

# 8. Two simultaneous redemptions of one remaining unit yield one rejection.
$redemptionOne = [guid]::NewGuid()
$redemptionTwo = [guid]::NewGuid()
$results = Invoke-ConcurrentPair `
  "select quantity_remaining from public.skie_redeem_entitlement('$retryEntitlementId','$failureEvent',1,'$door','$redemptionOne')" `
  "select quantity_remaining from public.skie_redeem_entitlement('$retryEntitlementId','$failureEvent',1,'$door','$redemptionTwo')"
Assert-OneSuccessOneConflict $results "ENTITLEMENT_NOT_REDEEMABLE" "final entitlement unit"
$redemptionCounts = Invoke-DatabaseQuery "select quantity_remaining || '|' || (select count(*) from public.entitlement_redemptions where entitlement_id = '$retryEntitlementId') from public.entitlements where id = '$retryEntitlementId'"
Assert-True ($redemptionCounts -eq "0|1") "final entitlement persisted count"
Write-Output "PASS|concurrency-08-entitlement-redemption"

# 9. Two workers claim one notification; one receives no row.
$notificationKey = "$runTag-notification"
[void](Invoke-DatabaseQuery "insert into public.notification_outbox(channel,template_key,recipient_user_id,recipient_address,event_id,payload,idempotency_key) values ('email','local','$customerA','$($customerA.ToString('N'))@local.invalid','$failureEvent','{}','$notificationKey'); select 'OK'")
$notificationSql = "select coalesce((select id::text from public.skie_claim_notification('email',30) limit 1),'NONE')"
$results = Invoke-ConcurrentPair $notificationSql $notificationSql
Assert-True ((@($results | Where-Object ExitCode -eq 0)).Count -eq 2) "notification workers complete"
Assert-True ((@($results | Where-Object Stdout -eq "NONE")).Count -eq 1) "one notification worker receives no claim"
Assert-True ((Invoke-DatabaseQuery "select status || '|' || attempt_count from public.notification_outbox where idempotency_key = '$notificationKey'") -eq "claimed|1") "notification claim persisted state"
Write-Output "PASS|concurrency-09-notification-claim"

# 10. Two users race for the final promo redemption.
$promoEvent = "$runTag-promo"
$promoKeyA = [guid]::NewGuid()
$promoKeyB = [guid]::NewGuid()
Assert-True ((Invoke-DatabaseQuery (New-ReservationSql $customerA $promoKeyA $promoEvent "$runTag-promo-tt" 4 4)) -eq "OK") "promo customer A reservation"
Assert-True ((Invoke-DatabaseQuery (New-ReservationSql $customerB $promoKeyB $promoEvent "$runTag-promo-tt" 4 4)) -eq "OK") "promo customer B reservation"
$promoId = [guid]::NewGuid()
[void](Invoke-DatabaseQuery "insert into public.promo_codes(id,code,internal_name,discount_type,percent_off,max_redemptions,max_discounted_ticket_units,max_uses_per_customer,status,created_by) values ('$promoId','PROMO-$runTag','Local Promo','percentage',10,1,1,1,'active','$admin'); select 'OK'")
$promoReservationA = ReservationIdSql $promoKeyA
$promoReservationB = ReservationIdSql $promoKeyB
$promoOrderA = OrderIdSql $promoKeyA
$promoOrderB = OrderIdSql $promoKeyB
$results = Invoke-ConcurrentPair `
  "select id from public.skie_claim_promo_usage('$promoId',($promoReservationA),($promoOrderA),'$customerA','$promoEvent',1,1000,100,900,now() + interval '30 minutes')" `
  "select id from public.skie_claim_promo_usage('$promoId',($promoReservationB),($promoOrderB),'$customerB','$promoEvent',1,1000,100,900,now() + interval '30 minutes')"
Assert-OneSuccessOneConflict $results "PROMO_REDEMPTION_LIMIT" "final promo redemption"
Assert-True ((Invoke-DatabaseQuery "select count(*) from public.promo_redemptions where promo_code_id = '$promoId' and status = 'reserved'") -eq "1") "final promo persisted count"
Write-Output "PASS|concurrency-10-promo-claim"

Write-Output "PASS|phase2-local-database-verification"
