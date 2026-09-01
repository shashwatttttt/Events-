-- SKIE EVENTS Phase 3 launch hardening.
-- Additive local-first migration: CMS event controls, staff audit/windows, and shared rate limits.

begin;

alter table public.event_staff_assignments
  add column if not exists starts_at timestamptz,
  add column if not exists ends_at timestamptz,
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by uuid references public.profiles(id) on delete restrict;

update public.event_staff_assignments set starts_at = coalesce(starts_at, created_at);
update public.event_staff_assignments
  set revoked_at=coalesce(revoked_at,updated_at),revoked_by=coalesce(revoked_by,assigned_by)
  where not active;
alter table public.event_staff_assignments alter column starts_at set default now();
alter table public.event_staff_assignments alter column starts_at set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'event_staff_assignments_window_check'
  ) then
    alter table public.event_staff_assignments
      add constraint event_staff_assignments_window_check check (ends_at is null or ends_at > starts_at);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'event_staff_assignments_revocation_check'
  ) then
    alter table public.event_staff_assignments
      add constraint event_staff_assignments_revocation_check check (
        (active and revoked_at is null and revoked_by is null)
        or (not active and revoked_at is not null and revoked_by is not null)
      );
  end if;
end;
$$;

create table if not exists public.event_staff_assignment_audit (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.event_staff_assignments(id) on delete restrict,
  event_id text not null,
  subject_user_id uuid not null references public.profiles(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  action text not null check (action in ('assigned','updated','revoked')),
  role text not null check (role in ('scanner_only','door_staff','event_admin')),
  starts_at timestamptz not null,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);

create index if not exists staff_assignment_current_idx
  on public.event_staff_assignments(user_id,event_id,starts_at,ends_at)
  where active;
create index if not exists staff_assignment_audit_event_idx
  on public.event_staff_assignment_audit(event_id,created_at desc);

create table if not exists public.event_sale_controls (
  event_id text primary key,
  sales_enabled boolean not null,
  state_signature text not null,
  document_version bigint not null check (document_version > 0),
  updated_by uuid not null references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now()
);

create table if not exists public.event_state_audit (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  previous_state text,
  next_state text not null,
  document_version bigint not null,
  correlation_id uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists event_state_audit_event_idx
  on public.event_state_audit(event_id,created_at desc);

create table if not exists public.rate_limit_buckets (
  key_hash text not null check (key_hash ~ '^[0-9a-f]{32}$'),
  window_started_at timestamptz not null,
  expires_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now(),
  primary key (key_hash,window_started_at),
  check (expires_at > window_started_at)
);

create index if not exists rate_limit_expiry_idx on public.rate_limit_buckets(expires_at);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'event_staff_assignment_audit','event_sale_controls','event_state_audit','rate_limit_buckets'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on table public.%I to service_role', table_name);
  end loop;
end;
$$;

create or replace function public.skie_event_sales_enabled(p_event jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(p_event ->> 'lifecycle','') = 'published'
    and coalesce(p_event ->> 'visibility','') in ('public','private_link','password')
    and coalesce(p_event ->> 'ticketMode','') in ('invite_only','direct_purchase','free_rsvp');
$$;

create or replace function public.skie_replace_site_document(
  p_expected_version bigint,
  p_payload jsonb,
  p_actor_id uuid,
  p_correlation_id uuid
)
returns table(saved_payload jsonb, saved_version bigint, saved_updated_at timestamptz, closed_event_ids jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_document public.platform_documents;
  v_previous_payload jsonb;
  v_event jsonb;
  v_previous_event jsonb;
  v_event_id text;
  v_signature text;
  v_previous_signature text;
  v_enabled boolean;
  v_previous_enabled boolean;
  v_closed jsonb := '[]'::jsonb;
  v_role public.user_role;
begin
  select role into v_role from public.profiles where id = p_actor_id;
  if v_role not in ('admin','super_admin') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if jsonb_typeof(p_payload -> 'events') <> 'array' then
    raise exception using errcode = '22023', message = 'INVALID_SITE_EVENTS';
  end if;

  select * into v_document from public.platform_documents where key = 'site' for update;
  if not found or v_document.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'CMS_STALE_VERSION';
  end if;
  v_previous_payload := v_document.payload;

  update public.platform_documents
    set payload = p_payload, version = v_document.version + 1, updated_at = now()
    where key = 'site'
    returning * into v_document;

  for v_event in select value from jsonb_array_elements(p_payload -> 'events')
  loop
    v_event_id := v_event ->> 'id';
    if coalesce(v_event_id,'') = '' then
      raise exception using errcode = '22023', message = 'INVALID_EVENT_ID';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('event:' || v_event_id,0));
    select value into v_previous_event
      from jsonb_array_elements(coalesce(v_previous_payload -> 'events','[]'::jsonb)) as previous(value)
      where value ->> 'id' = v_event_id
      limit 1;
    select state_signature,sales_enabled into v_previous_signature,v_previous_enabled
      from public.event_sale_controls where event_id = v_event_id;
    if not found and v_previous_event is not null then
      v_previous_signature := concat_ws('|',v_previous_event ->> 'lifecycle',v_previous_event ->> 'visibility',v_previous_event ->> 'ticketMode');
      v_previous_enabled := public.skie_event_sales_enabled(v_previous_event);
    end if;
    v_signature := concat_ws('|',v_event ->> 'lifecycle',v_event ->> 'visibility',v_event ->> 'ticketMode');
    v_enabled := public.skie_event_sales_enabled(v_event);
    if coalesce(v_previous_enabled,false) and not v_enabled then
      v_closed := v_closed || jsonb_build_array(v_event_id);
    end if;
    insert into public.event_sale_controls(event_id,sales_enabled,state_signature,document_version,updated_by,updated_at)
      values (v_event_id,v_enabled,v_signature,v_document.version,p_actor_id,now())
      on conflict (event_id) do update set
        sales_enabled = excluded.sales_enabled,
        state_signature = excluded.state_signature,
        document_version = excluded.document_version,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
      where public.event_sale_controls.document_version <= excluded.document_version;
    if v_previous_signature is distinct from v_signature then
      insert into public.event_state_audit(event_id,actor_id,previous_state,next_state,document_version,correlation_id)
        values (v_event_id,p_actor_id,v_previous_signature,v_signature,v_document.version,p_correlation_id);
    end if;
    v_previous_event := null;
    v_previous_signature := null;
    v_previous_enabled := null;
  end loop;

  for v_previous_event in select value from jsonb_array_elements(coalesce(v_previous_payload -> 'events','[]'::jsonb))
  loop
    v_event_id := v_previous_event ->> 'id';
    if not exists(select 1 from jsonb_array_elements(p_payload -> 'events') item where item ->> 'id' = v_event_id) then
      perform pg_advisory_xact_lock(hashtextextended('event:' || v_event_id,0));
      if public.skie_event_sales_enabled(v_previous_event) then
        v_closed := v_closed || jsonb_build_array(v_event_id);
      end if;
      insert into public.event_sale_controls(event_id,sales_enabled,state_signature,document_version,updated_by,updated_at)
        values (v_event_id,false,'removed',v_document.version,p_actor_id,now())
        on conflict (event_id) do update set sales_enabled=false,state_signature='removed',document_version=excluded.document_version,updated_by=excluded.updated_by,updated_at=excluded.updated_at;
      insert into public.event_state_audit(event_id,actor_id,previous_state,next_state,document_version,correlation_id)
        values (v_event_id,p_actor_id,concat_ws('|',v_previous_event ->> 'lifecycle',v_previous_event ->> 'visibility',v_previous_event ->> 'ticketMode'),'removed',v_document.version,p_correlation_id);
    end if;
  end loop;

  return query select v_document.payload,v_document.version,v_document.updated_at,v_closed;
end;
$$;

create or replace function public.skie_manage_event_staff_assignment(
  p_action text,
  p_assignment_id uuid,
  p_user_id uuid,
  p_event_id text,
  p_role text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_actor_id uuid
)
returns public.event_staff_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role public.user_role;
  v_subject_role public.user_role;
  v_assignment public.event_staff_assignments;
  v_action text;
begin
  select role into v_actor_role from public.profiles where id = p_actor_id;
  if v_actor_role not in ('admin','super_admin') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if p_action = 'revoke' then
    select * into v_assignment from public.event_staff_assignments where id = p_assignment_id for update;
    if not found then raise exception using errcode = 'P0002', message = 'STAFF_ASSIGNMENT_NOT_FOUND'; end if;
    update public.event_staff_assignments
      set active=false,revoked_at=now(),revoked_by=p_actor_id
      where id=v_assignment.id returning * into v_assignment;
    v_action := 'revoked';
  elsif p_action = 'assign' then
    if p_user_id is null or coalesce(p_event_id,'') = '' or p_role not in ('scanner_only','door_staff','event_admin')
      or p_starts_at is null or (p_ends_at is not null and p_ends_at <= p_starts_at) then
      raise exception using errcode = '22023', message = 'INVALID_STAFF_ASSIGNMENT';
    end if;
    select role into v_subject_role from public.profiles where id = p_user_id;
    if v_subject_role is null or v_subject_role = 'customer'
      or (v_subject_role = 'scanner_only' and p_role <> 'scanner_only')
      or (v_subject_role = 'door_staff' and p_role = 'event_admin') then
      raise exception using errcode = '42501', message = 'INVALID_STAFF_ROLE';
    end if;
    select * into v_assignment from public.event_staff_assignments
      where user_id=p_user_id and event_id=p_event_id and role=p_role for update;
    v_action := case when found then 'updated' else 'assigned' end;
    insert into public.event_staff_assignments(user_id,event_id,role,active,assigned_by,starts_at,ends_at,revoked_at,revoked_by)
      values (p_user_id,p_event_id,p_role,true,p_actor_id,p_starts_at,p_ends_at,null,null)
      on conflict (user_id,event_id,role) do update set
        active=true,assigned_by=excluded.assigned_by,starts_at=excluded.starts_at,ends_at=excluded.ends_at,revoked_at=null,revoked_by=null
      returning * into v_assignment;
  else
    raise exception using errcode = '22023', message = 'INVALID_STAFF_ACTION';
  end if;
  insert into public.event_staff_assignment_audit(assignment_id,event_id,subject_user_id,actor_id,action,role,starts_at,ends_at)
    values (v_assignment.id,v_assignment.event_id,v_assignment.user_id,p_actor_id,v_action,v_assignment.role,v_assignment.starts_at,v_assignment.ends_at);
  return v_assignment;
end;
$$;

create or replace function public.skie_consume_rate_limit(
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns table(allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window timestamptz;
  v_count integer;
begin
  if p_key_hash !~ '^[0-9a-f]{32}$' or p_limit < 1 or p_limit > 10000 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception using errcode = '22023', message = 'INVALID_RATE_LIMIT';
  end if;
  v_window := to_timestamp(floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limit_buckets(key_hash,window_started_at,expires_at,request_count,updated_at)
    values (p_key_hash,v_window,v_window + make_interval(secs => p_window_seconds),1,v_now)
    on conflict (key_hash,window_started_at) do update
      set request_count=public.rate_limit_buckets.request_count + 1,updated_at=v_now
      where public.rate_limit_buckets.request_count < p_limit
    returning request_count into v_count;
  if v_count is null then
    select request_count into v_count from public.rate_limit_buckets
      where key_hash=p_key_hash and window_started_at=v_window;
    return query select false,0,greatest(1,ceil(extract(epoch from (v_window + make_interval(secs => p_window_seconds) - v_now)))::integer);
  else
    return query select true,greatest(0,p_limit-v_count),greatest(1,ceil(extract(epoch from (v_window + make_interval(secs => p_window_seconds) - v_now)))::integer);
  end if;
end;
$$;

create or replace function public.skie_cleanup_rate_limits(p_limit integer default 1000)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if p_limit < 1 or p_limit > 10000 then raise exception using errcode = '22023', message = 'INVALID_CLEANUP_LIMIT'; end if;
  with expired as (
    select ctid from public.rate_limit_buckets where expires_at < now() order by expires_at limit p_limit
  )
  delete from public.rate_limit_buckets bucket using expired where bucket.ctid=expired.ctid;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

create or replace function public.skie_reserve_checkout_v2(
  p_customer_id uuid,
  p_customer_email text,
  p_customer_name text,
  p_event_id text,
  p_event_title text,
  p_event_public_capacity integer,
  p_currency text,
  p_expires_at timestamptz,
  p_ticket_lines jsonb,
  p_product_lines jsonb default '[]'::jsonb,
  p_allocation_id text default null,
  p_expected_discount_cents integer default 0,
  p_reservation_key uuid default gen_random_uuid(),
  p_version integer default 1
)
returns table(reservation_id uuid, order_id uuid, checkout_attempt_id uuid, idempotency_key uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('event:' || p_event_id,0));
  if exists(select 1 from public.event_sale_controls where event_id=p_event_id and not sales_enabled) then
    raise exception using errcode = 'P0001', message = 'EVENT_SALES_CLOSED';
  end if;
  return query select * from public.skie_reserve_checkout(
    p_customer_id,p_customer_email,p_customer_name,p_event_id,p_event_title,p_event_public_capacity,
    p_currency,p_expires_at,p_ticket_lines,p_product_lines,p_allocation_id,p_expected_discount_cents,
    p_reservation_key,p_version
  );
end;
$$;

create or replace function public.skie_check_in(
  p_ticket_id uuid,
  p_token_hash text,
  p_expected_event_id text,
  p_actor_id uuid,
  p_notes text default ''
)
returns table(result text, ticket_status text, checked_in_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket public.tickets;
  v_role public.user_role;
  v_result text;
begin
  select role into v_role from public.profiles where id = p_actor_id;
  if v_role not in ('admin','super_admin') and not exists(
    select 1 from public.event_staff_assignments
    where user_id=p_actor_id and event_id=p_expected_event_id and active
      and starts_at <= now() and (ends_at is null or ends_at > now())
      and role in ('scanner_only','door_staff','event_admin')
  ) then raise exception using errcode = '42501', message = 'EVENT_ASSIGNMENT_REQUIRED'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found then v_result := 'invalid';
  elsif v_ticket.token_hash <> p_token_hash then v_result := 'invalid';
  elsif v_ticket.event_id <> p_expected_event_id then v_result := 'wrong_event';
  elsif v_ticket.status = 'checked_in' then v_result := 'already_checked_in';
  elsif v_ticket.status <> 'valid' then v_result := v_ticket.status;
  else
    v_result := 'valid';
    update public.tickets set status='checked_in',checked_in_at=now(),checked_in_by=p_actor_id where id=p_ticket_id returning * into v_ticket;
  end if;
  if found then
    insert into public.check_ins(ticket_id,event_id,scanned_by,result,notes)
      values (p_ticket_id,p_expected_event_id,p_actor_id,v_result,left(coalesce(p_notes,''),1000));
  end if;
  return query select v_result,v_ticket.status,v_ticket.checked_in_at;
end;
$$;

create or replace function public.skie_redeem_entitlement(
  p_entitlement_id uuid,
  p_expected_event_id text,
  p_quantity integer,
  p_actor_id uuid,
  p_idempotency_key uuid
)
returns public.entitlements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entitlement public.entitlements;
  v_role public.user_role;
begin
  select role into v_role from public.profiles where id=p_actor_id;
  if v_role not in ('admin','super_admin') and not exists(
    select 1 from public.event_staff_assignments
    where user_id=p_actor_id and event_id=p_expected_event_id and active
      and starts_at <= now() and (ends_at is null or ends_at > now())
      and role in ('door_staff','event_admin')
  ) then raise exception using errcode = '42501', message = 'EVENT_ASSIGNMENT_REQUIRED'; end if;
  if exists(select 1 from public.entitlement_redemptions where idempotency_key=p_idempotency_key) then
    select entitlement.* into v_entitlement from public.entitlements entitlement where id=p_entitlement_id;
    return v_entitlement;
  end if;
  select * into v_entitlement from public.entitlements where id=p_entitlement_id for update;
  if not found or v_entitlement.event_id <> p_expected_event_id then
    raise exception using errcode = 'P0002', message = 'ENTITLEMENT_NOT_FOUND';
  end if;
  if v_entitlement.status <> 'active' or p_quantity < 1 or p_quantity > v_entitlement.quantity_remaining then
    raise exception using errcode = 'P0001', message = 'ENTITLEMENT_NOT_REDEEMABLE';
  end if;
  update public.entitlements set
    quantity_remaining=quantity_remaining-p_quantity,
    status=case when quantity_remaining-p_quantity=0 then 'redeemed' else 'active' end
    where id=p_entitlement_id returning * into v_entitlement;
  insert into public.entitlement_redemptions(entitlement_id,event_id,quantity,redeemed_by,idempotency_key)
    values (p_entitlement_id,p_expected_event_id,p_quantity,p_actor_id,p_idempotency_key);
  return v_entitlement;
end;
$$;

do $$
declare
  function_signature text;
begin
  foreach function_signature in array array[
    'public.skie_event_sales_enabled(jsonb)',
    'public.skie_replace_site_document(bigint,jsonb,uuid,uuid)',
    'public.skie_manage_event_staff_assignment(text,uuid,uuid,text,text,timestamptz,timestamptz,uuid)',
    'public.skie_consume_rate_limit(text,integer,integer)',
    'public.skie_cleanup_rate_limits(integer)',
    'public.skie_reserve_checkout_v2(uuid,text,text,text,text,integer,text,timestamptz,jsonb,jsonb,text,integer,uuid,integer)'
  ] loop
    execute format('revoke all on function %s from public,anon,authenticated',function_signature);
    execute format('grant execute on function %s to service_role',function_signature);
  end loop;
end;
$$;

revoke all on function public.skie_check_in(uuid,text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.skie_check_in(uuid,text,text,uuid,text) to service_role;
revoke all on function public.skie_redeem_entitlement(uuid,text,integer,uuid,uuid) from public,anon,authenticated;
grant execute on function public.skie_redeem_entitlement(uuid,text,integer,uuid,uuid) to service_role;

commit;
