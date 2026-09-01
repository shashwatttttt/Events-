-- Audited, fail-closed removal of disposable test customers and tickets.
-- Disposable access records are removed so they cannot appear in customer accounts,
-- QR verification, door redemption, control-panel projections or analytics.
-- Immutable orders, payments and recovery history are never erased.

begin;

alter table public.profiles
  add column if not exists admin_deleted_at timestamptz,
  add column if not exists admin_deleted_by uuid references public.profiles(id) on delete restrict,
  add column if not exists admin_delete_reason text;

alter table public.tickets
  add column if not exists admin_deleted_at timestamptz,
  add column if not exists admin_deleted_by uuid references public.profiles(id) on delete restrict,
  add column if not exists admin_delete_reason text;

create table if not exists public.admin_test_data_tombstones (
  entity_type text not null check (entity_type in ('customer','ticket')),
  entity_id uuid not null,
  deleted_at timestamptz not null default now(),
  deleted_by uuid not null references public.profiles(id) on delete restrict,
  reason text not null,
  primary key (entity_type, entity_id)
);

alter table public.admin_test_data_tombstones enable row level security;

create index if not exists profiles_admin_visible_idx
  on public.profiles(created_at desc)
  where admin_deleted_at is null;

create index if not exists tickets_admin_visible_idx
  on public.tickets(created_at desc)
  where admin_deleted_at is null;

create or replace function public.skie_admin_assert_super_admin(p_actor_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.user_role;
begin
  select role into v_role from public.profiles where id = p_actor_id and admin_deleted_at is null;
  if v_role is distinct from 'super_admin'::public.user_role then
    raise exception 'SUPER_ADMIN_REQUIRED';
  end if;
end;
$$;

create or replace function public.skie_admin_remove_test_ticket(
  p_actor_id uuid,
  p_ticket_id uuid,
  p_reason text,
  p_confirmation text,
  p_idempotency_key text
)
returns table(ticket_id uuid, deleted_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket public.tickets%rowtype;
  v_deleted_at timestamptz := now();
begin
  perform public.skie_admin_assert_super_admin(p_actor_id);
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'REASON_REQUIRED'; end if;

  select tombstone.deleted_at into v_deleted_at
  from public.admin_test_data_tombstones tombstone
  where tombstone.entity_type = 'ticket' and tombstone.entity_id = p_ticket_id;
  if found then
    return query select p_ticket_id, v_deleted_at;
    return;
  end if;

  select * into v_ticket
  from public.tickets
  where id = p_ticket_id
  for update;

  if v_ticket.id is null then raise exception 'TICKET_NOT_FOUND'; end if;
  if trim(coalesce(p_confirmation, '')) <> v_ticket.ticket_code then
    raise exception 'TICKET_CONFIRMATION_MISMATCH';
  end if;
  if v_ticket.status in ('checked_in','refunded') or v_ticket.checked_in_at is not null then
    raise exception 'TEST_TICKET_HAS_ATTENDANCE_OR_REFUND';
  end if;
  if exists(select 1 from public.check_ins where ticket_id = v_ticket.id) then
    raise exception 'TEST_TICKET_HAS_CHECK_IN_HISTORY';
  end if;
  if exists(
    select 1
    from public.payments p
    where p.order_id = v_ticket.order_id
      and (
        p.provider = 'stripe'
        or p.status in ('refund_pending','refunded','partially_refunded','disputed','suspended','manual_review')
      )
  ) then
    raise exception 'TEST_TICKET_HAS_PROTECTED_PAYMENT';
  end if;
  if exists(
    select 1
    from public.entitlement_redemptions r
    join public.entitlements e on e.id = r.entitlement_id
    where e.order_id = v_ticket.order_id
  ) then
    raise exception 'TEST_TICKET_HAS_REDEMPTION_HISTORY';
  end if;
  if exists(
    select 1 from public.payment_recovery_actions
    where order_id = v_ticket.order_id and status <> 'completed'
  ) then
    raise exception 'TEST_TICKET_HAS_UNRESOLVED_RECOVERY';
  end if;

  insert into public.admin_test_data_tombstones(entity_type, entity_id, deleted_at, deleted_by, reason)
  values ('ticket', v_ticket.id, v_deleted_at, p_actor_id, left(trim(p_reason), 500))
  on conflict (entity_type, entity_id) do nothing;

  delete from public.analytics_events
  where deduplication_key = 'ticket_issued:' || v_ticket.id::text;

  perform public.skie_admin_record_operation(
    p_actor_id,
    'test_ticket.removed',
    'ticket',
    v_ticket.id::text,
    left(trim(p_reason), 500),
    p_idempotency_key,
    jsonb_build_object('eventId', v_ticket.event_id, 'orderId', v_ticket.order_id)
  );

  delete from public.tickets where id = v_ticket.id;

  return query select v_ticket.id, v_deleted_at;
end;
$$;

create or replace function public.skie_admin_remove_test_customer(
  p_actor_id uuid,
  p_customer_id uuid,
  p_reason text,
  p_confirmation text,
  p_idempotency_key text
)
returns table(customer_id uuid, deleted_at timestamptz, hidden_tickets integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_deleted_at timestamptz := now();
  v_hidden_tickets integer := 0;
begin
  perform public.skie_admin_assert_super_admin(p_actor_id);
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'REASON_REQUIRED'; end if;

  select * into v_profile
  from public.profiles
  where id = p_customer_id
  for update;

  if v_profile.id is null then raise exception 'CUSTOMER_NOT_FOUND'; end if;
  if v_profile.admin_deleted_at is not null then
    return query select v_profile.id, v_profile.admin_deleted_at, 0;
    return;
  end if;
  if v_profile.role <> 'customer'::public.user_role then raise exception 'CUSTOMER_ROLE_PROTECTED'; end if;
  if lower(trim(coalesce(p_confirmation, ''))) <> lower(v_profile.email) then
    raise exception 'CUSTOMER_CONFIRMATION_MISMATCH';
  end if;
  if exists(select 1 from public.event_staff_assignments where user_id = v_profile.id and active) then
    raise exception 'CUSTOMER_HAS_STAFF_ACCESS';
  end if;
  if exists(select 1 from public.promo_codes where created_by = v_profile.id) then
    raise exception 'CUSTOMER_OWNS_PROMO_CODE';
  end if;
  if exists(
    select 1
    from public.payments p
    join public.orders o on o.id = p.order_id
    where o.customer_id = v_profile.id
      and (
        p.provider = 'stripe'
        or p.status in ('refund_pending','refunded','partially_refunded','disputed','suspended','manual_review')
      )
  ) then
    raise exception 'CUSTOMER_HAS_PROTECTED_PAYMENT';
  end if;
  if exists(
    select 1
    from public.check_ins c
    join public.tickets t on t.id = c.ticket_id
    where t.customer_id = v_profile.id
  ) then
    raise exception 'CUSTOMER_HAS_CHECK_IN_HISTORY';
  end if;
  if exists(
    select 1
    from public.entitlement_redemptions r
    join public.entitlements e on e.id = r.entitlement_id
    where e.customer_id = v_profile.id
  ) then
    raise exception 'CUSTOMER_HAS_REDEMPTION_HISTORY';
  end if;
  if exists(
    select 1
    from public.post_checkout_applications a
    where a.customer_id = v_profile.id
      and (
        a.stripe_payment_intent_id is not null
        or a.payment_status in ('authorized','capture_requested','captured','reconciliation_required')
      )
  ) then
    raise exception 'CUSTOMER_HAS_PROTECTED_AUTHORIZATION';
  end if;
  if exists(
    select 1
    from public.payment_recovery_actions r
    join public.orders o on o.id = r.order_id
    where o.customer_id = v_profile.id and r.status <> 'completed'
  ) then
    raise exception 'CUSTOMER_HAS_UNRESOLVED_RECOVERY';
  end if;

  select count(*)::integer into v_hidden_tickets
  from public.tickets where customer_id = v_profile.id;

  insert into public.admin_test_data_tombstones(entity_type, entity_id, deleted_at, deleted_by, reason)
  select 'ticket', ticket.id, v_deleted_at, p_actor_id, left(trim(p_reason), 500)
  from public.tickets ticket
  where ticket.customer_id = v_profile.id
  on conflict (entity_type, entity_id) do nothing;

  insert into public.admin_test_data_tombstones(entity_type, entity_id, deleted_at, deleted_by, reason)
  values ('customer', v_profile.id, v_deleted_at, p_actor_id, left(trim(p_reason), 500))
  on conflict (entity_type, entity_id) do nothing;

  delete from public.analytics_events where customer_id = v_profile.id;
  delete from public.tickets where customer_id = v_profile.id;
  delete from public.entitlements where customer_id = v_profile.id;

  update public.profiles
  set admin_deleted_at = v_deleted_at,
      admin_deleted_by = p_actor_id,
      admin_delete_reason = left(trim(p_reason), 500),
      first_name = 'Removed',
      last_name = 'Test customer',
      phone = '',
      instagram = '',
      tags = array[]::text[],
      internal_notes = '',
      updated_at = v_deleted_at
  where id = v_profile.id;

  perform public.skie_admin_record_operation(
    p_actor_id,
    'test_customer.removed',
    'customer',
    v_profile.id::text,
    left(trim(p_reason), 500),
    p_idempotency_key,
    jsonb_build_object('removedTickets', v_hidden_tickets)
  );

  return query select v_profile.id, v_deleted_at, v_hidden_tickets;
end;
$$;

create or replace function public.skie_analytics_report(
  p_start_date date,
  p_end_date date,
  p_event_id text,
  p_campaign text,
  p_channel text
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with filtered as (
  select analytics.*
  from public.analytics_events analytics
  where analytics.melbourne_date between p_start_date and p_end_date
    and (p_event_id is null or analytics.event_id = p_event_id)
    and (p_campaign is null or analytics.utm_campaign = p_campaign)
    and (p_channel is null or analytics.notification_channel = p_channel)
    and (
      analytics.customer_id is null
      or not exists (
        select 1 from public.profiles profile
        where profile.id = analytics.customer_id and profile.admin_deleted_at is not null
      )
    )
), grouped_type as (
  select event_name,count(*)::integer count,coalesce(sum(revenue_cents),0)::bigint revenue_cents,
    coalesce(sum(quantity),0)::bigint quantity
  from filtered group by event_name
), grouped_date as (
  select melbourne_date,count(*)::integer count,coalesce(sum(revenue_cents),0)::bigint revenue_cents
  from filtered group by melbourne_date order by melbourne_date
)
select jsonb_build_object(
  'startDate',p_start_date,
  'endDate',p_end_date,
  'totals',jsonb_build_object(
    'events',(select count(*) from filtered),
    'revenueCents',(select coalesce(sum(revenue_cents),0) from filtered where event_name='payment_completed'),
    'ticketQuantity',(select coalesce(sum(quantity),0) from filtered where event_name='ticket_issued')
  ),
  'byEventType',coalesce((select jsonb_agg(jsonb_build_object(
    'eventName',event_name,'count',count,'revenueCents',revenue_cents,'quantity',quantity
  ) order by event_name) from grouped_type),'[]'::jsonb),
  'byDate',coalesce((select jsonb_agg(jsonb_build_object(
    'date',melbourne_date,'count',count,'revenueCents',revenue_cents
  ) order by melbourne_date) from grouped_date),'[]'::jsonb)
);
$$;

revoke all on table public.admin_test_data_tombstones from public, anon, authenticated;
grant select, insert on table public.admin_test_data_tombstones to service_role;
revoke all on function public.skie_admin_assert_super_admin(uuid) from public, anon, authenticated;
revoke all on function public.skie_admin_remove_test_ticket(uuid,uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.skie_admin_remove_test_customer(uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.skie_admin_assert_super_admin(uuid) to service_role;
grant execute on function public.skie_admin_remove_test_ticket(uuid,uuid,text,text,text) to service_role;
grant execute on function public.skie_admin_remove_test_customer(uuid,uuid,text,text,text) to service_role;

commit;
