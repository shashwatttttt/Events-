-- SKIE EVENTS launch transaction foundation.
-- Additive only: this migration does not modify or remove platform_documents data.
-- Apply to isolated staging first and follow MIGRATION_RUNBOOK.md.

begin;

create extension if not exists pgcrypto;

create or replace function public.skie_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.ticket_allocations (
  id text primary key check (length(id) between 1 and 120),
  customer_id uuid not null references public.profiles(id) on delete restrict,
  application_id text,
  event_id text not null check (length(event_id) between 1 and 120),
  ticket_type_id text not null check (length(ticket_type_id) between 1 and 120),
  max_quantity integer not null check (max_quantity between 1 and 20),
  purchased_quantity integer not null default 0 check (purchased_quantity >= 0),
  price_cents integer not null check (price_cents >= 0),
  status text not null check (status in ('unlocked','checkout_started','expired','cancelled','ticket_issued')),
  expires_at timestamptz not null,
  approved_by uuid not null references public.profiles(id) on delete restrict,
  approved_at timestamptz not null,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (purchased_quantity <= max_quantity)
);

create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  reservation_key uuid not null default gen_random_uuid(),
  version integer not null default 1 check (version > 0),
  customer_id uuid not null references public.profiles(id) on delete restrict,
  event_id text not null check (length(event_id) between 1 and 120),
  allocation_id text references public.ticket_allocations(id) on delete restrict,
  promo_code_id uuid,
  status text not null default 'reserved' check (status in (
    'reserved','session_active','payment_received','fulfilment_pending','fulfilled',
    'expired','cancelled','failed','paid_unfulfilled','refund_pending','refunded',
    'partially_refunded','disputed','suspended','manual_review','recovery_failed'
  )),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  expected_subtotal_cents integer not null check (expected_subtotal_cents >= 0),
  expected_discount_cents integer not null default 0 check (expected_discount_cents >= 0),
  expected_total_cents integer not null check (expected_total_cents >= 0),
  expires_at timestamptz not null,
  customer_email text not null check (length(customer_email) between 3 and 254),
  customer_name text not null check (length(customer_name) between 1 and 200),
  event_title text not null check (length(event_title) between 1 and 240),
  correlation_id uuid not null default gen_random_uuid(),
  failure_code text,
  recovery_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (reservation_key, version),
  check (expected_total_cents = expected_subtotal_cents - expected_discount_cents),
  check (expires_at > created_at)
);

create table if not exists public.reservation_ticket_lines (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  ticket_type_id text not null check (length(ticket_type_id) between 1 and 120),
  name text not null check (length(name) between 1 and 240),
  quantity integer not null check (quantity between 1 and 20),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  ticket_type_capacity integer not null check (ticket_type_capacity >= 0),
  event_public_capacity integer not null check (event_public_capacity >= 0),
  customer_limit integer not null check (customer_limit between 1 and 20),
  created_at timestamptz not null default now(),
  unique (reservation_id, ticket_type_id)
);

create table if not exists public.reservation_product_lines (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  product_id text not null check (length(product_id) between 1 and 120),
  name text not null check (length(name) between 1 and 240),
  quantity integer not null check (quantity between 1 and 100),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  stock_quantity integer not null check (stock_quantity >= 0),
  max_per_customer integer not null check (max_per_customer >= 1),
  units_per_purchase integer not null default 1 check (units_per_purchase between 1 and 100),
  redeemable boolean not null default false,
  created_at timestamptz not null default now(),
  unique (reservation_id, product_id)
);

create table if not exists public.checkout_attempts (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  reservation_version integer not null check (reservation_version > 0),
  status text not null default 'creating_session' check (status in (
    'creating_session','session_active','session_expired','session_failed','orphan_session',
    'payment_received','fulfilled','manual_review','recovery_failed'
  )),
  idempotency_key uuid not null default gen_random_uuid() unique,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  provider_expires_at timestamptz,
  correlation_id uuid not null default gen_random_uuid(),
  failure_code text,
  recovery_attempts integer not null default 0 check (recovery_attempts >= 0),
  last_recovery_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (reservation_id, reservation_version)
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null unique references public.reservations(id) on delete restrict,
  customer_id uuid not null references public.profiles(id) on delete restrict,
  event_id text not null,
  allocation_id text references public.ticket_allocations(id) on delete restrict,
  status text not null default 'reserved' check (status in (
    'reserved','checkout_pending','payment_received','fulfilment_pending','fulfilled',
    'failed','expired','cancelled','paid_unfulfilled','refund_pending','refunded',
    'partially_refunded','disputed','suspended','manual_review','recovery_failed'
  )),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  subtotal_cents integer not null check (subtotal_cents >= 0),
  discount_cents integer not null default 0 check (discount_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  refunded_cents integer not null default 0 check (refunded_cents >= 0),
  paid_at timestamptz,
  fulfilled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (total_cents = subtotal_cents - discount_cents),
  check (refunded_cents <= total_cents)
);

create table if not exists public.order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  reservation_ticket_line_id uuid references public.reservation_ticket_lines(id) on delete restrict,
  reservation_product_line_id uuid references public.reservation_product_lines(id) on delete restrict,
  kind text not null check (kind in ('ticket','product')),
  reference_id text not null,
  name text not null,
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  refunded_quantity integer not null default 0 check (refunded_quantity >= 0),
  refunded_cents integer not null default 0 check (refunded_cents >= 0),
  created_at timestamptz not null default now(),
  unique (order_id, reservation_ticket_line_id),
  unique (order_id, reservation_product_line_id),
  check ((kind = 'ticket' and reservation_ticket_line_id is not null and reservation_product_line_id is null)
    or (kind = 'product' and reservation_product_line_id is not null and reservation_ticket_line_id is null)),
  check (refunded_quantity <= quantity),
  check (refunded_cents <= quantity * unit_price_cents)
);

alter table public.checkout_attempts
  add column if not exists order_id uuid references public.orders(id) on delete restrict;
alter table public.checkout_attempts alter column order_id set not null;
create unique index if not exists checkout_attempts_order_unique on public.checkout_attempts(order_id);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  checkout_attempt_id uuid references public.checkout_attempts(id) on delete restrict,
  provider text not null check (provider in ('stripe','test','free')),
  provider_reference text,
  status text not null check (status in (
    'payment_received','paid','failed','cancelled','refund_pending','refunded',
    'partially_refunded','disputed','suspended','manual_review'
  )),
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  amount_cents integer not null check (amount_cents >= 0),
  refunded_cents integer not null default 0 check (refunded_cents >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  provider_created_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (refunded_cents <= amount_cents)
);

create unique index if not exists payments_stripe_session_unique
  on public.payments(stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;
create unique index if not exists payments_stripe_pi_unique
  on public.payments(stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;
create unique index if not exists payments_provider_reference_unique
  on public.payments(provider,provider_reference)
  where provider_reference is not null;

create table if not exists public.payment_adjustments (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete restrict,
  kind text not null check (kind in ('refund','dispute')),
  provider_object_id text not null unique,
  status text not null check (status in (
    'pending','succeeded','failed','needs_response','won','lost','closed','manual_review'
  )),
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  line_attribution jsonb,
  provider_created_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.stripe_webhook_events (
  stripe_event_id text primary key,
  event_type text not null,
  livemode boolean not null,
  api_version text,
  object_id text,
  checkout_session_id text,
  payment_intent_id text,
  charge_id text,
  refund_id text,
  dispute_id text,
  status text not null default 'received' check (status in (
    'received','processing','processed','temporary_failure','permanent_failure','manual_review'
  )),
  processing_attempts integer not null default 0 check (processing_attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  correlation_id uuid not null default gen_random_uuid(),
  safe_error_code text,
  provider_created_at timestamptz not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.tickets (
  id uuid primary key,
  order_id uuid not null references public.orders(id) on delete restrict,
  order_line_id uuid not null references public.order_lines(id) on delete restrict,
  event_id text not null,
  customer_id uuid not null references public.profiles(id) on delete restrict,
  ticket_type_id text not null,
  ticket_code text not null unique,
  token_hash text not null unique check (length(token_hash) >= 32),
  token_preview text not null check (length(token_preview) <= 12),
  holder_name text not null,
  status text not null default 'valid' check (status in (
    'valid','checked_in','cancelled','refunded','expired','transferred',
    'entry_refused','suspended'
  )),
  status_before_suspension text,
  checked_in_at timestamptz,
  checked_in_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, id),
  check (status_before_suspension is null or status_before_suspension in (
    'valid','checked_in','cancelled','refunded','expired','transferred','entry_refused'
  ))
);

create table if not exists public.entitlements (
  id uuid primary key,
  order_id uuid not null references public.orders(id) on delete restrict,
  order_line_id uuid not null references public.order_lines(id) on delete restrict,
  event_id text not null,
  customer_id uuid not null references public.profiles(id) on delete restrict,
  product_id text not null,
  name text not null,
  quantity_total integer not null check (quantity_total > 0),
  quantity_remaining integer not null check (quantity_remaining >= 0),
  status text not null default 'active' check (status in (
    'active','redeemed','cancelled','refunded','suspended'
  )),
  status_before_suspension text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_line_id),
  check (quantity_remaining <= quantity_total),
  check (status_before_suspension is null or status_before_suspension in ('active','redeemed','cancelled','refunded'))
);

create table if not exists public.event_staff_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  event_id text not null,
  role text not null check (role in ('scanner_only','door_staff','event_admin')),
  active boolean not null default true,
  assigned_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, event_id, role)
);

create table if not exists public.check_ins (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete restrict,
  event_id text not null,
  scanned_by uuid not null references public.profiles(id) on delete restrict,
  result text not null check (result in (
    'valid','already_checked_in','wrong_event','cancelled','refunded',
    'expired','suspended','entry_refused','invalid'
  )),
  notes text not null default '' check (length(notes) <= 1000),
  scanned_at timestamptz not null default now()
);

create table if not exists public.entitlement_redemptions (
  id uuid primary key default gen_random_uuid(),
  entitlement_id uuid not null references public.entitlements(id) on delete restrict,
  event_id text not null,
  quantity integer not null check (quantity > 0),
  redeemed_by uuid not null references public.profiles(id) on delete restrict,
  idempotency_key uuid not null unique,
  redeemed_at timestamptz not null default now()
);

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('email','sms')),
  template_key text not null,
  recipient_user_id uuid references public.profiles(id) on delete restrict,
  recipient_address text not null,
  event_id text,
  order_id uuid references public.orders(id) on delete restrict,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text not null unique,
  status text not null default 'queued' check (status in (
    'queued','claimed','sent','delivered','temporary_failure','failed','dry_run','cancelled'
  )),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  available_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  provider_message_id text,
  safe_error_code text,
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.notification_attempts (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references public.notification_outbox(id) on delete restrict,
  attempt_number integer not null check (attempt_number > 0),
  status text not null check (status in (
    'claimed','accepted','sent','delivered','temporary_failure','permanent_failure','dry_run'
  )),
  provider_message_id text,
  safe_error_code text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (outbox_id, attempt_number)
);

create table if not exists public.promo_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  internal_name text not null,
  description text not null default '',
  active boolean not null default true,
  discount_type text not null check (discount_type in ('percentage','fixed')),
  percent_off numeric(5,2),
  amount_off_cents integer,
  currency text not null default 'AUD' check (currency = 'AUD'),
  valid_from timestamptz,
  expires_at timestamptz,
  max_redemptions integer check (max_redemptions > 0),
  max_discounted_ticket_units integer check (max_discounted_ticket_units > 0),
  max_uses_per_customer integer check (max_uses_per_customer > 0),
  minimum_order_cents integer not null default 0 check (minimum_order_cents >= 0),
  first_purchase_only boolean not null default false,
  event_ids text[] not null default '{}',
  ticket_type_ids text[] not null default '{}',
  product_ids text[] not null default '{}',
  stripe_coupon_id text unique,
  stripe_promotion_code_id text unique,
  status text not null default 'draft' check (status in ('draft','active','inactive','expired','provider_error')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((discount_type = 'percentage' and percent_off > 0 and percent_off <= 100 and amount_off_cents is null)
    or (discount_type = 'fixed' and amount_off_cents > 0 and percent_off is null)),
  check (expires_at is null or valid_from is null or expires_at > valid_from)
);

create unique index if not exists promo_codes_code_lower_unique on public.promo_codes(lower(code));

alter table public.reservations
  add constraint reservations_promo_code_fk
  foreign key (promo_code_id) references public.promo_codes(id) on delete restrict;

create table if not exists public.promo_redemptions (
  id uuid primary key default gen_random_uuid(),
  promo_code_id uuid not null references public.promo_codes(id) on delete restrict,
  reservation_id uuid not null unique references public.reservations(id) on delete restrict,
  order_id uuid unique references public.orders(id) on delete restrict,
  customer_id uuid not null references public.profiles(id) on delete restrict,
  event_id text not null,
  status text not null default 'reserved' check (status in ('reserved','released','finalized','refunded','disputed')),
  discounted_ticket_units integer not null check (discounted_ticket_units > 0),
  original_subtotal_cents integer not null check (original_subtotal_cents >= 0),
  discount_cents integer not null check (discount_cents >= 0),
  final_total_cents integer not null check (final_total_cents >= 0),
  reserved_until timestamptz not null,
  finalized_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (final_total_cents = original_subtotal_cents - discount_cents)
);

create table if not exists public.payment_recovery_actions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete restrict,
  reservation_id uuid references public.reservations(id) on delete restrict,
  action text not null check (action in (
    'retry_fulfilment','refresh_stripe','expire_session','resend_ticket_email',
    'resend_payment_sms','suspend_ticket','reinstate_ticket','request_refund',
    'mark_manual_review','mark_resolved','automatic_recovery'
  )),
  actor_id uuid references public.profiles(id) on delete restrict,
  actor_label text not null,
  idempotency_key text not null unique,
  status text not null check (status in ('requested','completed','failed','manual_review')),
  safe_metadata jsonb not null default '{}'::jsonb,
  safe_error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists reservations_event_status_expiry_idx
  on public.reservations(event_id, status, expires_at);
create index if not exists reservations_customer_event_idx
  on public.reservations(customer_id, event_id, created_at desc);
create unique index if not exists reservations_active_allocation_unique
  on public.reservations(allocation_id)
  where allocation_id is not null and status in ('reserved','session_active','payment_received','fulfilment_pending','paid_unfulfilled');
create index if not exists ticket_allocations_customer_event_idx
  on public.ticket_allocations(customer_id,event_id,status);
create index if not exists checkout_attempts_status_idx
  on public.checkout_attempts(status, created_at);
create index if not exists orders_recovery_idx
  on public.orders(status, updated_at)
  where status in ('payment_received','fulfilment_pending','paid_unfulfilled','refund_pending','partially_refunded','disputed','suspended','manual_review','recovery_failed');
create index if not exists payments_order_idx on public.payments(order_id, created_at desc);
create index if not exists payment_adjustments_order_idx on public.payment_adjustments(order_id, created_at desc);
create index if not exists stripe_webhook_retry_idx
  on public.stripe_webhook_events(status, next_attempt_at)
  where status in ('received','temporary_failure');
create index if not exists tickets_event_code_idx on public.tickets(event_id, ticket_code);
create index if not exists tickets_customer_idx on public.tickets(customer_id, created_at desc);
create index if not exists entitlements_event_customer_idx on public.entitlements(event_id, customer_id, status);
create index if not exists check_ins_event_time_idx on public.check_ins(event_id, scanned_at desc);
create index if not exists staff_event_idx on public.event_staff_assignments(event_id, user_id) where active;
create index if not exists notification_due_idx
  on public.notification_outbox(channel, status, available_at)
  where status in ('queued','temporary_failure');
create index if not exists promo_redemptions_usage_idx on public.promo_redemptions(promo_code_id, status);

create or replace function public.skie_reservation_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if row(
    new.reservation_key,new.version,new.customer_id,new.event_id,new.allocation_id,
    new.promo_code_id,new.currency,new.expected_subtotal_cents,new.expected_discount_cents,
    new.expected_total_cents,new.expires_at,new.customer_email,new.customer_name,new.event_title,
    new.correlation_id,new.created_at
  ) is distinct from row(
    old.reservation_key,old.version,old.customer_id,old.event_id,old.allocation_id,
    old.promo_code_id,old.currency,old.expected_subtotal_cents,old.expected_discount_cents,
    old.expected_total_cents,old.expires_at,old.customer_email,old.customer_name,old.event_title,
    old.correlation_id,old.created_at
  ) then
    raise exception using errcode = '23514', message = 'RESERVATION_SNAPSHOT_IMMUTABLE';
  end if;
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists reservations_immutable_trigger on public.reservations;
create trigger reservations_immutable_trigger
before update on public.reservations
for each row execute function public.skie_reservation_immutable();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'ticket_allocations','checkout_attempts','orders','payments','payment_adjustments','tickets','entitlements',
    'event_staff_assignments','stripe_webhook_events','notification_outbox',
    'promo_codes','promo_redemptions'
  ] loop
    execute format('drop trigger if exists %I on public.%I', table_name || '_touch_updated_at', table_name);
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.skie_touch_updated_at()',
      table_name || '_touch_updated_at', table_name
    );
  end loop;
end;
$$;

create or replace function public.skie_immutable_row()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception using errcode = '23514', message = 'IMMUTABLE_TRANSACTION_ROW';
end;
$$;

-- Trigger helpers are internal implementation details, not client RPCs.
revoke all on function public.skie_touch_updated_at() from public, anon, authenticated;
revoke all on function public.skie_reservation_immutable() from public, anon, authenticated;
revoke all on function public.skie_immutable_row() from public, anon, authenticated;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['reservation_ticket_lines','reservation_product_lines','order_lines'] loop
    execute format('drop trigger if exists %I on public.%I', table_name || '_immutable', table_name);
    execute format(
      'create trigger %I before update or delete on public.%I for each row execute function public.skie_immutable_row()',
      table_name || '_immutable', table_name
    );
  end loop;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'ticket_allocations','reservations','reservation_ticket_lines','reservation_product_lines','checkout_attempts',
    'orders','order_lines','payments','payment_adjustments','stripe_webhook_events','tickets','entitlements',
    'event_staff_assignments','check_ins','entitlement_redemptions','notification_outbox',
    'notification_attempts','promo_codes','promo_redemptions','payment_recovery_actions'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on table public.%I to service_role', table_name);
  end loop;
end;
$$;

commit;
