-- Phase 4: additive admin convenience, recovery and launch-readiness controls.

create table if not exists public.admin_operation_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  action text not null check (action ~ '^[a-z][a-z0-9_.]{2,79}$'),
  entity_type text not null check (entity_type ~ '^[a-z][a-z0-9_]{1,39}$'),
  entity_id text not null check (length(entity_id) between 1 and 160),
  reason text check (reason is null or length(reason) between 3 and 500),
  idempotency_key text not null unique check (length(idempotency_key) between 8 and 200),
  safe_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_metadata) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists admin_operation_audit_entity_idx on public.admin_operation_audit(entity_type, entity_id, created_at desc);
create index if not exists admin_operation_audit_actor_idx on public.admin_operation_audit(actor_id, created_at desc);

create table if not exists public.admin_saved_filters (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.profiles(id) on delete cascade,
  scope text not null check (scope in ('applications','ticketing','notifications','analytics')),
  name text not null check (length(name) between 1 and 80),
  filters jsonb not null default '{}'::jsonb check (jsonb_typeof(filters) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(actor_id, scope, name)
);
create index if not exists admin_saved_filters_actor_scope_idx on public.admin_saved_filters(actor_id, scope, updated_at desc);

create table if not exists public.event_launch_readiness (
  event_id text primary key,
  checklist jsonb not null default '{}'::jsonb check (jsonb_typeof(checklist) = 'object'),
  low_stock_threshold integer not null default 10 check (low_stock_threshold between 0 and 100000),
  capacity_warning_percent integer not null default 90 check (capacity_warning_percent between 1 and 100),
  updated_by uuid not null references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now()
);

alter table public.entitlement_redemptions add column if not exists reversed_at timestamptz;
alter table public.entitlement_redemptions add column if not exists reversed_by uuid references public.profiles(id) on delete restrict;
alter table public.entitlement_redemptions add column if not exists reversal_reason text;
alter table public.check_ins add column if not exists reversed_at timestamptz;
alter table public.check_ins add column if not exists reversed_by uuid references public.profiles(id) on delete restrict;
alter table public.check_ins add column if not exists reversal_reason text;

alter table public.admin_operation_audit enable row level security;
alter table public.admin_saved_filters enable row level security;
alter table public.event_launch_readiness enable row level security;
revoke all on table public.admin_operation_audit, public.admin_saved_filters, public.event_launch_readiness from public, anon, authenticated;
grant select, insert, update, delete on table public.admin_operation_audit, public.admin_saved_filters, public.event_launch_readiness to service_role;

create or replace function public.skie_admin_assert_actor(p_actor_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_role public.user_role;
begin
  select role into v_role from public.profiles where id=p_actor_id;
  if v_role not in ('admin','super_admin') then raise exception 'ADMIN_REQUIRED'; end if;
end;$$;

create or replace function public.skie_admin_record_operation(
  p_actor_id uuid, p_action text, p_entity_type text, p_entity_id text,
  p_reason text, p_idempotency_key text, p_safe_metadata jsonb default '{}'::jsonb
) returns public.admin_operation_audit
language plpgsql security definer set search_path=public as $$
declare v_item public.admin_operation_audit;
begin
  perform public.skie_admin_assert_actor(p_actor_id);
  if p_safe_metadata::text ~* '(secret|token|password|card|email|phone|provider.payload|raw.payload)' then raise exception 'UNSAFE_METADATA'; end if;
  insert into public.admin_operation_audit(actor_id,action,entity_type,entity_id,reason,idempotency_key,safe_metadata)
  values(p_actor_id,p_action,p_entity_type,p_entity_id,nullif(trim(p_reason),''),p_idempotency_key,coalesce(p_safe_metadata,'{}'::jsonb))
  on conflict(idempotency_key) do update set idempotency_key=excluded.idempotency_key
  returning * into v_item;
  return v_item;
end;$$;

create or replace function public.skie_admin_save_filter(
  p_actor_id uuid, p_scope text, p_name text, p_filters jsonb
) returns public.admin_saved_filters
language plpgsql security definer set search_path=public as $$
declare v_item public.admin_saved_filters;
begin
  perform public.skie_admin_assert_actor(p_actor_id);
  insert into public.admin_saved_filters(actor_id,scope,name,filters)
  values(p_actor_id,p_scope,trim(p_name),coalesce(p_filters,'{}'::jsonb))
  on conflict(actor_id,scope,name) do update set filters=excluded.filters,updated_at=now()
  returning * into v_item;
  return v_item;
end;$$;

create or replace function public.skie_admin_save_launch_readiness(
  p_actor_id uuid, p_event_id text, p_checklist jsonb,
  p_low_stock_threshold integer, p_capacity_warning_percent integer,
  p_idempotency_key text
) returns public.event_launch_readiness
language plpgsql security definer set search_path=public as $$
declare v_item public.event_launch_readiness;
begin
  perform public.skie_admin_assert_actor(p_actor_id);
  if p_checklist::text ~* '(secret|token|password|card|email|phone)' then raise exception 'UNSAFE_CHECKLIST'; end if;
  insert into public.event_launch_readiness(event_id,checklist,low_stock_threshold,capacity_warning_percent,updated_by)
  values(p_event_id,coalesce(p_checklist,'{}'::jsonb),p_low_stock_threshold,p_capacity_warning_percent,p_actor_id)
  on conflict(event_id) do update set checklist=excluded.checklist,low_stock_threshold=excluded.low_stock_threshold,
    capacity_warning_percent=excluded.capacity_warning_percent,updated_by=excluded.updated_by,updated_at=now()
  returning * into v_item;
  perform public.skie_admin_record_operation(p_actor_id,'launch_readiness.updated','event',p_event_id,null,p_idempotency_key,
    jsonb_build_object('lowStockThreshold',p_low_stock_threshold,'capacityWarningPercent',p_capacity_warning_percent));
  return v_item;
end;$$;

create or replace function public.skie_admin_reissue_ticket(
  p_actor_id uuid, p_ticket_id uuid, p_reason text, p_new_ticket_id uuid,
  p_new_ticket_code text, p_new_token_hash text, p_new_token_preview text, p_idempotency_key text
) returns public.tickets
language plpgsql security definer set search_path=public as $$
declare v_old public.tickets; v_new public.tickets; v_existing_id uuid;
begin
  perform public.skie_admin_assert_actor(p_actor_id);
  if length(trim(p_reason)) < 3 then raise exception 'REASON_REQUIRED'; end if;
  select * into v_old from public.tickets where id=p_ticket_id for update;
  if v_old.id is null then raise exception 'TICKET_NOT_FOUND'; end if;
  if v_old.status not in ('valid','checked_in') then raise exception 'TICKET_NOT_REISSUABLE'; end if;
  select (safe_metadata->>'replacementTicketId')::uuid into v_existing_id from public.admin_operation_audit where idempotency_key=p_idempotency_key;
  if v_existing_id is not null then
    select * into v_new from public.tickets where id=v_existing_id; return v_new;
  end if;
  update public.tickets set status='transferred',updated_at=now() where id=v_old.id;
  insert into public.tickets(id,order_id,order_line_id,event_id,customer_id,ticket_type_id,ticket_code,token_hash,token_preview,holder_name,status,created_at,updated_at)
  values(p_new_ticket_id,v_old.order_id,v_old.order_line_id,v_old.event_id,v_old.customer_id,v_old.ticket_type_id,p_new_ticket_code,p_new_token_hash,p_new_token_preview,v_old.holder_name,'valid',now(),now())
  returning * into v_new;
  perform public.skie_admin_record_operation(p_actor_id,'ticket.reissued','ticket',v_old.id::text,p_reason,p_idempotency_key,jsonb_build_object('replacementTicketId',v_new.id));
  return v_new;
end;$$;

create or replace function public.skie_admin_reverse_check_in(
  p_actor_id uuid, p_ticket_id uuid, p_reason text, p_idempotency_key text
) returns public.tickets
language plpgsql security definer set search_path=public as $$
declare v_ticket public.tickets; v_scan public.check_ins;
begin
  perform public.skie_admin_assert_actor(p_actor_id);
  if length(trim(p_reason)) < 3 then raise exception 'REASON_REQUIRED'; end if;
  if exists(select 1 from public.admin_operation_audit where idempotency_key=p_idempotency_key) then select * into v_ticket from public.tickets where id=p_ticket_id; return v_ticket; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if v_ticket.id is null or v_ticket.status <> 'checked_in' then raise exception 'CHECK_IN_NOT_REVERSIBLE'; end if;
  select * into v_scan from public.check_ins where ticket_id=p_ticket_id and result='valid' and reversed_at is null order by scanned_at desc limit 1 for update;
  if v_scan.id is null then raise exception 'CHECK_IN_RECORD_NOT_FOUND'; end if;
  update public.check_ins set reversed_at=now(),reversed_by=p_actor_id,reversal_reason=trim(p_reason) where id=v_scan.id;
  update public.tickets set status='valid',checked_in_at=null,checked_in_by=null,updated_at=now() where id=p_ticket_id returning * into v_ticket;
  perform public.skie_admin_record_operation(p_actor_id,'check_in.reversed','ticket',p_ticket_id::text,p_reason,p_idempotency_key,jsonb_build_object('checkInId',v_scan.id));
  return v_ticket;
end;$$;

create or replace function public.skie_admin_reverse_entitlement_redemption(
  p_actor_id uuid, p_redemption_id uuid, p_reason text, p_idempotency_key text
) returns public.entitlements
language plpgsql security definer set search_path=public as $$
declare v_redemption public.entitlement_redemptions; v_entitlement public.entitlements;
begin
  perform public.skie_admin_assert_actor(p_actor_id);
  if length(trim(p_reason)) < 3 then raise exception 'REASON_REQUIRED'; end if;
  if exists(select 1 from public.admin_operation_audit where idempotency_key=p_idempotency_key) then
    select e.* into v_entitlement from public.entitlements e join public.entitlement_redemptions r on r.entitlement_id=e.id where r.id=p_redemption_id; return v_entitlement;
  end if;
  select * into v_redemption from public.entitlement_redemptions where id=p_redemption_id for update;
  if v_redemption.id is null or v_redemption.reversed_at is not null then raise exception 'REDEMPTION_NOT_REVERSIBLE'; end if;
  update public.entitlements set quantity_remaining=least(quantity_total,quantity_remaining+v_redemption.quantity),
    status=case when status='redeemed' then 'active' else status end,updated_at=now()
  where id=v_redemption.entitlement_id returning * into v_entitlement;
  update public.entitlement_redemptions set reversed_at=now(),reversed_by=p_actor_id,reversal_reason=trim(p_reason) where id=v_redemption.id;
  perform public.skie_admin_record_operation(p_actor_id,'entitlement_redemption.reversed','entitlement',v_entitlement.id::text,p_reason,p_idempotency_key,jsonb_build_object('redemptionId',v_redemption.id,'quantity',v_redemption.quantity));
  begin
    perform public.skie_capture_analytics_event(
      'addon_redemption_reversal','server','addon_redemption_reversal:'||v_redemption.id,now(),
      v_redemption.event_id,null,null,null,null,null,null,null,null,null,null,null,null,v_redemption.quantity,'{}'::jsonb
    );
  exception when others then null;
  end;
  return v_entitlement;
end;$$;

revoke all on function public.skie_admin_assert_actor(uuid) from public, anon, authenticated;
revoke all on function public.skie_admin_record_operation(uuid,text,text,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.skie_admin_save_filter(uuid,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.skie_admin_save_launch_readiness(uuid,text,jsonb,integer,integer,text) from public, anon, authenticated;
revoke all on function public.skie_admin_reissue_ticket(uuid,uuid,text,uuid,text,text,text,text) from public, anon, authenticated;
revoke all on function public.skie_admin_reverse_check_in(uuid,uuid,text,text) from public, anon, authenticated;
revoke all on function public.skie_admin_reverse_entitlement_redemption(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.skie_admin_assert_actor(uuid) to service_role;
grant execute on function public.skie_admin_record_operation(uuid,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.skie_admin_save_filter(uuid,text,text,jsonb) to service_role;
grant execute on function public.skie_admin_save_launch_readiness(uuid,text,jsonb,integer,integer,text) to service_role;
grant execute on function public.skie_admin_reissue_ticket(uuid,uuid,text,uuid,text,text,text,text) to service_role;
grant execute on function public.skie_admin_reverse_check_in(uuid,uuid,text,text) to service_role;
grant execute on function public.skie_admin_reverse_entitlement_redemption(uuid,uuid,text,text) to service_role;
