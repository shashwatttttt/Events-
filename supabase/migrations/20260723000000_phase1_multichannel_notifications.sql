-- SKIE EVENTS launch Phase 1: transactional multi-channel notifications.
-- Forward-only migration. No provider calls and no seed data.

begin;

alter table public.notification_outbox
  add column if not exists provider_status text,
  add column if not exists provider_status_updated_at timestamptz,
  add column if not exists read_at timestamptz;

alter table public.notification_outbox drop constraint if exists notification_outbox_channel_check;
alter table public.notification_outbox add constraint notification_outbox_channel_check
  check (channel in ('email','sms','in_app','whatsapp'));
alter table public.notification_outbox drop constraint if exists notification_outbox_status_check;
alter table public.notification_outbox add constraint notification_outbox_status_check
  check (status in ('queued','processing','retry','claimed','sent','delivered','temporary_failure','failed','dry_run','cancelled'));

alter table public.notification_attempts drop constraint if exists notification_attempts_status_check;
alter table public.notification_attempts add constraint notification_attempts_status_check
  check (status in ('processing','retry','claimed','accepted','sent','delivered','temporary_failure','permanent_failure','dry_run'));

alter table public.notification_admin_audit drop constraint if exists notification_admin_audit_action_check;
alter table public.notification_admin_audit add constraint notification_admin_audit_action_check
  check (action in ('retry','cancel','ticket_resend','test_send','manual_message','control_update'));

create table if not exists public.notification_preferences (
  user_id uuid not null references public.profiles(id) on delete cascade,
  channel text not null check (channel in ('email','sms','in_app','whatsapp')),
  enabled boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, channel)
);

create table if not exists public.notification_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  channel text not null check (channel in ('sms','whatsapp')),
  consent_type text not null check (consent_type = 'transactional'),
  accepted boolean not null,
  text_shown text not null check (length(text_shown) between 10 and 1000),
  policy_version text not null check (length(policy_version) between 1 and 40),
  ip_hash text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  user_agent text check (user_agent is null or length(user_agent) <= 500),
  created_at timestamptz not null default now()
);

create index if not exists notification_consents_latest_idx
  on public.notification_consents(user_id, channel, created_at desc);

create table if not exists public.notification_channel_controls (
  channel text primary key check (channel in ('email','sms','in_app','whatsapp')),
  enabled boolean not null,
  updated_by uuid references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now()
);

insert into public.notification_channel_controls(channel, enabled) values
  ('email', true), ('sms', false), ('in_app', true), ('whatsapp', false)
on conflict (channel) do nothing;

create table if not exists public.event_notification_controls (
  event_id text not null,
  channel text not null check (channel in ('email','sms','in_app','whatsapp')),
  enabled boolean not null,
  updated_by uuid references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now(),
  primary key (event_id, channel)
);

create table if not exists public.notification_provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('twilio','resend')),
  provider_event_id text not null,
  provider_message_id text not null,
  provider_status text not null,
  mapped_status text not null check (mapped_status in ('sent','delivered','failed')),
  outbox_id uuid references public.notification_outbox(id) on delete restrict,
  received_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

create table if not exists public.notification_settings_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  action text not null check (action = 'control_update'),
  channel text not null check (channel in ('email','sms','in_app','whatsapp')),
  event_id text,
  enabled boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists notification_provider_events_message_idx
  on public.notification_provider_events(provider, provider_message_id, received_at desc);
create index if not exists notification_in_app_customer_idx
  on public.notification_outbox(recipient_user_id, created_at desc)
  where channel = 'in_app' and status not in ('cancelled','failed');

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'notification_preferences','notification_consents','notification_channel_controls',
    'event_notification_controls','notification_provider_events','notification_settings_audit'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public,anon,authenticated', table_name);
    execute format('grant select,insert,update,delete on table public.%I to service_role', table_name);
  end loop;
end;
$$;

create or replace function public.skie_enqueue_notification(
  p_channel text, p_template_key text, p_recipient_user_id uuid, p_recipient_address text,
  p_recipient_hash text, p_event_id text, p_order_id uuid, p_payload jsonb,
  p_idempotency_key text, p_max_attempts integer default 5
)
returns table(item jsonb, inserted boolean)
language plpgsql security definer set search_path = public
as $$
declare v_item public.notification_outbox; v_inserted boolean := false;
begin
  if p_channel not in ('email','sms','in_app','whatsapp')
    or length(trim(p_template_key)) not between 1 and 80
    or length(trim(p_recipient_address)) not between 1 and 254
    or p_recipient_hash !~ '^[0-9a-f]{64}$'
    or length(trim(p_idempotency_key)) not between 1 and 200
    or p_max_attempts not between 1 and 20
    or jsonb_typeof(coalesce(p_payload, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'INVALID_NOTIFICATION';
  end if;
  insert into public.notification_outbox(
    channel, template_key, recipient_user_id, recipient_address, recipient_hash,
    event_id, order_id, payload, idempotency_key, max_attempts
  ) values (
    p_channel, trim(p_template_key), p_recipient_user_id, trim(p_recipient_address), p_recipient_hash,
    nullif(trim(p_event_id), ''), p_order_id, coalesce(p_payload, '{}'::jsonb), trim(p_idempotency_key), p_max_attempts
  ) on conflict (idempotency_key) do nothing returning * into v_item;
  if found then v_inserted := true;
  else select * into v_item from public.notification_outbox where idempotency_key = trim(p_idempotency_key);
  end if;
  return query select to_jsonb(v_item), v_inserted;
end;
$$;

create or replace function public.skie_claim_notification_batch(
  p_channel text, p_worker_id text, p_batch_size integer default 10, p_lease_seconds integer default 60
)
returns setof public.notification_outbox
language plpgsql security definer set search_path = public
as $$
declare v_id uuid; v_item public.notification_outbox;
begin
  if p_channel not in ('email','sms','in_app','whatsapp') or length(trim(p_worker_id)) not between 8 and 100
    or p_batch_size not between 1 and 25 or p_lease_seconds not between 10 and 300 then
    raise exception using errcode = '22023', message = 'INVALID_NOTIFICATION_CLAIM';
  end if;
  update public.notification_attempts attempt
    set status = 'retry', safe_error_code = 'NOTIFICATION_CLAIM_TIMEOUT', finished_at = now()
  from public.notification_outbox outbox
  where outbox.id = attempt.outbox_id and outbox.status in ('claimed','processing')
    and outbox.lease_expires_at <= now() and attempt.attempt_number = outbox.attempt_count and attempt.finished_at is null;
  update public.notification_outbox set status = 'retry', safe_error_code = 'NOTIFICATION_CLAIM_TIMEOUT',
    lease_expires_at = null, lease_owner = null, available_at = now(), updated_at = now()
  where status in ('claimed','processing') and lease_expires_at <= now();
  for v_id in
    select id from public.notification_outbox
    where channel = p_channel and status in ('queued','retry','temporary_failure')
      and available_at <= now() and attempt_count < max_attempts
    order by available_at, id for update skip locked limit p_batch_size
  loop
    update public.notification_outbox set status = 'processing', attempt_count = attempt_count + 1,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds), lease_owner = p_worker_id,
      safe_error_code = null, updated_at = now() where id = v_id returning * into v_item;
    insert into public.notification_attempts(outbox_id, attempt_number, status)
      values (v_item.id, v_item.attempt_count, 'processing');
    return next v_item;
  end loop;
end;
$$;

create or replace function public.skie_finish_notification(
  p_outbox_id uuid, p_worker_id text, p_result text, p_provider_message_id text,
  p_safe_error_code text, p_retry_delay_seconds integer default 30
)
returns public.notification_outbox
language plpgsql security definer set search_path = public
as $$
declare v_item public.notification_outbox; v_attempt_status text;
begin
  select * into v_item from public.notification_outbox where id = p_outbox_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'NOTIFICATION_NOT_FOUND'; end if;
  if v_item.status not in ('claimed','processing') or v_item.lease_owner is distinct from p_worker_id then
    raise exception using errcode = 'P0001', message = 'NOTIFICATION_LEASE_LOST';
  end if;
  if p_result not in ('accepted','sent','delivered','dry_run','temporary_failure','permanent_failure')
    or p_retry_delay_seconds not between 1 and 86400
    or (p_result in ('temporary_failure','permanent_failure') and coalesce(p_safe_error_code,'') = '') then
    raise exception using errcode = '22023', message = 'INVALID_NOTIFICATION_RESULT';
  end if;
  v_attempt_status := case when p_result = 'permanent_failure' then 'permanent_failure'
    when p_result = 'temporary_failure' then 'retry' else p_result end;
  update public.notification_attempts set status = v_attempt_status,
    provider_message_id = left(p_provider_message_id, 200), safe_error_code = left(p_safe_error_code, 100), finished_at = now()
  where outbox_id = v_item.id and attempt_number = v_item.attempt_count;
  update public.notification_outbox set
    status = case when p_result = 'dry_run' then 'dry_run' when p_result = 'delivered' then 'delivered'
      when p_result in ('accepted','sent') then 'sent'
      when p_result = 'permanent_failure' or attempt_count >= max_attempts then 'failed' else 'retry' end,
    provider_message_id = left(p_provider_message_id, 200), safe_error_code = left(p_safe_error_code, 100),
    provider_status = p_result, provider_status_updated_at = now(),
    sent_at = case when p_result in ('accepted','sent','delivered','dry_run') then now() else sent_at end,
    delivered_at = case when p_result = 'delivered' then now() else delivered_at end,
    available_at = case when p_result = 'temporary_failure' and attempt_count < max_attempts
      then now() + make_interval(secs => p_retry_delay_seconds) else available_at end,
    lease_expires_at = null, lease_owner = null, updated_at = now()
  where id = v_item.id returning * into v_item;
  return v_item;
end;
$$;

create or replace function public.skie_manage_notification(p_outbox_id uuid, p_action text, p_actor_id uuid)
returns public.notification_outbox
language plpgsql security definer set search_path = public
as $$
declare v_item public.notification_outbox; v_role public.user_role;
begin
  select role into v_role from public.profiles where id = p_actor_id;
  if v_role not in ('admin','super_admin') then raise exception using errcode = '42501', message = 'FORBIDDEN'; end if;
  select * into v_item from public.notification_outbox where id = p_outbox_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'NOTIFICATION_NOT_FOUND'; end if;
  if p_action = 'cancel' then
    if v_item.status not in ('queued','retry','temporary_failure') then raise exception using errcode = 'P0001', message = 'NOTIFICATION_NOT_CANCELLABLE'; end if;
    update public.notification_outbox set status = 'cancelled', updated_at = now() where id = p_outbox_id returning * into v_item;
  elsif p_action = 'retry' then
    if v_item.status not in ('retry','temporary_failure','failed') then raise exception using errcode = 'P0001', message = 'NOTIFICATION_NOT_RETRYABLE'; end if;
    update public.notification_outbox set status = 'queued', available_at = now(), safe_error_code = null,
      max_attempts = least(20, greatest(max_attempts, attempt_count + 1)), updated_at = now()
      where id = p_outbox_id returning * into v_item;
  else raise exception using errcode = '22023', message = 'INVALID_NOTIFICATION_ACTION';
  end if;
  insert into public.notification_admin_audit(outbox_id, actor_id, action) values (v_item.id, p_actor_id, p_action);
  return v_item;
end;
$$;

create or replace function public.skie_set_notification_control(
  p_actor_id uuid, p_channel text, p_enabled boolean, p_event_id text default null
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_role public.user_role;
begin
  select role into v_role from public.profiles where id = p_actor_id;
  if v_role not in ('admin','super_admin') then raise exception using errcode = '42501', message = 'FORBIDDEN'; end if;
  if p_channel not in ('email','sms','in_app','whatsapp') then raise exception using errcode = '22023', message = 'INVALID_NOTIFICATION_CHANNEL'; end if;
  if nullif(trim(p_event_id), '') is null then
    insert into public.notification_channel_controls(channel, enabled, updated_by, updated_at)
      values (p_channel, p_enabled, p_actor_id, now())
      on conflict (channel) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  else
    insert into public.event_notification_controls(event_id, channel, enabled, updated_by, updated_at)
      values (trim(p_event_id), p_channel, p_enabled, p_actor_id, now())
      on conflict (event_id, channel) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  end if;
  insert into public.notification_settings_audit(actor_id, action, channel, event_id, enabled)
    values (p_actor_id, 'control_update', p_channel, nullif(trim(p_event_id), ''), p_enabled);
  return jsonb_build_object('channel', p_channel, 'enabled', p_enabled, 'eventId', nullif(trim(p_event_id), ''));
end;
$$;

create or replace function public.skie_record_notification_admin_action(
  p_actor_id uuid, p_outbox_ids uuid[], p_action text
)
returns integer language plpgsql security definer set search_path = public
as $$
declare v_role public.user_role; v_count integer;
begin
  select role into v_role from public.profiles where id = p_actor_id;
  if v_role not in ('admin','super_admin') then raise exception using errcode = '42501', message = 'FORBIDDEN'; end if;
  if p_action not in ('ticket_resend','test_send','manual_message') or coalesce(array_length(p_outbox_ids, 1), 0) = 0 then
    raise exception using errcode = '22023', message = 'INVALID_NOTIFICATION_ADMIN_ACTION';
  end if;
  insert into public.notification_admin_audit(outbox_id, actor_id, action)
    select distinct requested.outbox_id, p_actor_id, p_action from unnest(p_outbox_ids) as requested(outbox_id)
    join public.notification_outbox item on item.id = requested.outbox_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.skie_record_notification_callback(
  p_provider text, p_provider_event_id text, p_provider_message_id text, p_provider_status text, p_mapped_status text
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_outbox_id uuid; v_inserted_id uuid;
begin
  if p_provider not in ('twilio','resend') or length(trim(p_provider_event_id)) not between 1 and 200
    or length(trim(p_provider_message_id)) not between 1 and 200
    or length(trim(p_provider_status)) not between 1 and 80
    or p_mapped_status not in ('sent','delivered','failed') then
    raise exception using errcode = '22023', message = 'INVALID_NOTIFICATION_CALLBACK';
  end if;
  select id into v_outbox_id from public.notification_outbox
    where ((p_provider = 'twilio' and channel in ('sms','whatsapp')) or (p_provider = 'resend' and channel = 'email'))
      and provider_message_id = trim(p_provider_message_id) order by created_at desc limit 1;
  insert into public.notification_provider_events(provider, provider_event_id, provider_message_id, provider_status, mapped_status, outbox_id)
    values (p_provider, trim(p_provider_event_id), trim(p_provider_message_id), trim(p_provider_status), p_mapped_status, v_outbox_id)
    on conflict (provider, provider_event_id) do nothing returning id into v_inserted_id;
  if v_inserted_id is not null and v_outbox_id is not null then
    update public.notification_outbox set
      status = case when p_mapped_status = 'delivered' then 'delivered' when p_mapped_status = 'failed' then 'failed' else status end,
      safe_error_code = case when p_mapped_status = 'failed' and p_provider = 'twilio' then 'SMS_PROVIDER_DELIVERY_FAILED'
        when p_mapped_status = 'failed' then 'EMAIL_PROVIDER_DELIVERY_FAILED' else safe_error_code end,
      provider_status = trim(p_provider_status), provider_status_updated_at = now(),
      delivered_at = case when p_mapped_status = 'delivered' then now() else delivered_at end, updated_at = now()
    where id = v_outbox_id;
  end if;
  return jsonb_build_object('matched', v_outbox_id is not null, 'duplicate', v_inserted_id is null);
end;
$$;

do $$
declare signature text;
begin
  foreach signature in array array[
    'public.skie_enqueue_notification(text,text,uuid,text,text,text,uuid,jsonb,text,integer)',
    'public.skie_claim_notification_batch(text,text,integer,integer)',
    'public.skie_finish_notification(uuid,text,text,text,text,integer)',
    'public.skie_manage_notification(uuid,text,uuid)',
    'public.skie_set_notification_control(uuid,text,boolean,text)',
    'public.skie_record_notification_admin_action(uuid,uuid[],text)',
    'public.skie_record_notification_callback(text,text,text,text,text)'
  ] loop
    execute format('revoke all on function %s from public,anon,authenticated', signature);
    execute format('grant execute on function %s to service_role', signature);
  end loop;
end;
$$;

commit;
