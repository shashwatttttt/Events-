-- SKIE EVENTS Phase 4 durable notification delivery.
-- Additive only; no provider calls or external cron configuration.

begin;

alter table public.notification_outbox
  add column if not exists recipient_hash text,
  add column if not exists correlation_id uuid not null default gen_random_uuid(),
  add column if not exists lease_owner text;

update public.notification_outbox
set recipient_hash = encode(digest(lower(recipient_address), 'sha256'), 'hex')
where recipient_hash is null;

alter table public.notification_outbox
  alter column recipient_hash set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'notification_outbox_recipient_hash_check') then
    alter table public.notification_outbox add constraint notification_outbox_recipient_hash_check
      check (recipient_hash ~ '^[0-9a-f]{64}$');
  end if;
end;
$$;

-- Preserve compatibility with the Phase 2 enqueue RPC and any reviewed service
-- insertion path while keeping the hash derived exclusively in PostgreSQL.
create or replace function public.skie_set_notification_recipient_hash()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.recipient_address := lower(trim(new.recipient_address));
  new.recipient_hash := encode(extensions.digest(new.recipient_address, 'sha256'), 'hex');
  return new;
end;
$$;

drop trigger if exists notification_outbox_recipient_hash on public.notification_outbox;
create trigger notification_outbox_recipient_hash
before insert or update of recipient_address on public.notification_outbox
for each row execute function public.skie_set_notification_recipient_hash();

revoke all on function public.skie_set_notification_recipient_hash() from public, anon, authenticated;

create table if not exists public.notification_admin_audit (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references public.notification_outbox(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  action text not null check (action in ('retry','cancel','ticket_resend','test_send')),
  created_at timestamptz not null default now()
);

create index if not exists notification_admin_audit_outbox_idx
  on public.notification_admin_audit(outbox_id, created_at desc);

alter table public.notification_admin_audit enable row level security;
revoke all on table public.notification_admin_audit from public, anon, authenticated;
grant select, insert, update, delete on table public.notification_admin_audit to service_role;

create or replace function public.skie_enqueue_notification(
  p_channel text,
  p_template_key text,
  p_recipient_user_id uuid,
  p_recipient_address text,
  p_recipient_hash text,
  p_event_id text,
  p_order_id uuid,
  p_payload jsonb,
  p_idempotency_key text,
  p_max_attempts integer default 5
)
returns table(item jsonb, inserted boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.notification_outbox;
  v_inserted boolean := false;
begin
  if p_channel not in ('email','sms')
    or length(trim(p_template_key)) < 1
    or length(trim(p_template_key)) > 80
    or length(trim(p_recipient_address)) < 3
    or length(trim(p_recipient_address)) > 254
    or p_recipient_hash !~ '^[0-9a-f]{64}$'
    or length(trim(p_idempotency_key)) < 1
    or length(trim(p_idempotency_key)) > 200
    or p_max_attempts < 1 or p_max_attempts > 20
    or jsonb_typeof(coalesce(p_payload, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'INVALID_NOTIFICATION';
  end if;

  insert into public.notification_outbox(
    channel, template_key, recipient_user_id, recipient_address, recipient_hash,
    event_id, order_id, payload, idempotency_key, max_attempts
  ) values (
    p_channel, trim(p_template_key), p_recipient_user_id, lower(trim(p_recipient_address)), p_recipient_hash,
    nullif(trim(p_event_id), ''), p_order_id, coalesce(p_payload, '{}'::jsonb), trim(p_idempotency_key), p_max_attempts
  ) on conflict (idempotency_key) do nothing
  returning * into v_item;

  if found then
    v_inserted := true;
  else
    select * into v_item from public.notification_outbox where idempotency_key = trim(p_idempotency_key);
  end if;
  return query select to_jsonb(v_item), v_inserted;
end;
$$;

create or replace function public.skie_claim_notification_batch(
  p_channel text,
  p_worker_id text,
  p_batch_size integer default 10,
  p_lease_seconds integer default 60
)
returns setof public.notification_outbox
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_item public.notification_outbox;
begin
  if p_channel not in ('email','sms') or length(trim(p_worker_id)) < 8 or length(trim(p_worker_id)) > 100
    or p_batch_size < 1 or p_batch_size > 25 or p_lease_seconds < 10 or p_lease_seconds > 300 then
    raise exception using errcode = '22023', message = 'INVALID_NOTIFICATION_CLAIM';
  end if;

  update public.notification_attempts attempt
    set status = 'temporary_failure', safe_error_code = 'NOTIFICATION_CLAIM_TIMEOUT', finished_at = now()
  from public.notification_outbox outbox
  where outbox.id = attempt.outbox_id and outbox.status = 'claimed'
    and outbox.lease_expires_at <= now() and attempt.attempt_number = outbox.attempt_count
    and attempt.finished_at is null;

  update public.notification_outbox
    set status = 'temporary_failure', safe_error_code = 'NOTIFICATION_CLAIM_TIMEOUT',
        lease_expires_at = null, lease_owner = null, available_at = now(), updated_at = now()
  where status = 'claimed' and lease_expires_at <= now();

  for v_id in
    select id from public.notification_outbox
    where channel = p_channel and status in ('queued','temporary_failure')
      and available_at <= now() and attempt_count < max_attempts
    order by available_at, id
    for update skip locked limit p_batch_size
  loop
    update public.notification_outbox
      set status = 'claimed', attempt_count = attempt_count + 1,
          lease_expires_at = now() + make_interval(secs => p_lease_seconds),
          lease_owner = p_worker_id, safe_error_code = null, updated_at = now()
      where id = v_id returning * into v_item;
    insert into public.notification_attempts(outbox_id, attempt_number, status)
      values (v_item.id, v_item.attempt_count, 'claimed');
    return next v_item;
  end loop;
end;
$$;

create or replace function public.skie_finish_notification(
  p_outbox_id uuid,
  p_worker_id text,
  p_result text,
  p_provider_message_id text,
  p_safe_error_code text,
  p_retry_delay_seconds integer default 30
)
returns public.notification_outbox
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.notification_outbox;
  v_attempt_status text;
begin
  select * into v_item from public.notification_outbox where id = p_outbox_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'NOTIFICATION_NOT_FOUND'; end if;
  if v_item.status <> 'claimed' or v_item.lease_owner is distinct from p_worker_id then
    raise exception using errcode = 'P0001', message = 'NOTIFICATION_LEASE_LOST';
  end if;
  if p_result not in ('accepted','sent','dry_run','temporary_failure','permanent_failure')
    or p_retry_delay_seconds < 1 or p_retry_delay_seconds > 86400
    or (p_result in ('temporary_failure','permanent_failure') and coalesce(p_safe_error_code,'') = '') then
    raise exception using errcode = '22023', message = 'INVALID_NOTIFICATION_RESULT';
  end if;

  v_attempt_status := case p_result when 'permanent_failure' then 'permanent_failure' else p_result end;
  update public.notification_attempts
    set status = v_attempt_status, provider_message_id = left(p_provider_message_id, 200),
        safe_error_code = left(p_safe_error_code, 100), finished_at = now()
    where outbox_id = v_item.id and attempt_number = v_item.attempt_count;

  update public.notification_outbox set
    status = case
      when p_result = 'dry_run' then 'dry_run'
      when p_result in ('accepted','sent') then 'sent'
      when p_result = 'permanent_failure' or attempt_count >= max_attempts then 'failed'
      else 'temporary_failure' end,
    provider_message_id = left(p_provider_message_id, 200),
    safe_error_code = left(p_safe_error_code, 100),
    sent_at = case when p_result in ('accepted','sent','dry_run') then now() else sent_at end,
    available_at = case when p_result = 'temporary_failure' and attempt_count < max_attempts
      then now() + make_interval(secs => p_retry_delay_seconds) else available_at end,
    lease_expires_at = null, lease_owner = null, updated_at = now()
  where id = v_item.id returning * into v_item;
  return v_item;
end;
$$;

create or replace function public.skie_manage_notification(
  p_outbox_id uuid,
  p_action text,
  p_actor_id uuid
)
returns public.notification_outbox
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.notification_outbox;
  v_role public.user_role;
begin
  select role into v_role from public.profiles where id = p_actor_id;
  if v_role not in ('admin','super_admin') then raise exception using errcode = '42501', message = 'FORBIDDEN'; end if;
  select * into v_item from public.notification_outbox where id = p_outbox_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'NOTIFICATION_NOT_FOUND'; end if;
  if p_action = 'cancel' then
    if v_item.status not in ('queued','temporary_failure') then raise exception using errcode = 'P0001', message = 'NOTIFICATION_NOT_CANCELLABLE'; end if;
    update public.notification_outbox set status = 'cancelled', updated_at = now() where id = p_outbox_id returning * into v_item;
  elsif p_action = 'retry' then
    if v_item.status not in ('temporary_failure','failed') or v_item.attempt_count >= v_item.max_attempts then
      raise exception using errcode = 'P0001', message = 'NOTIFICATION_NOT_RETRYABLE';
    end if;
    update public.notification_outbox set status = 'queued', available_at = now(), safe_error_code = null, updated_at = now()
      where id = p_outbox_id returning * into v_item;
  else
    raise exception using errcode = '22023', message = 'INVALID_NOTIFICATION_ACTION';
  end if;
  insert into public.notification_admin_audit(outbox_id, actor_id, action) values (v_item.id, p_actor_id, p_action);
  return v_item;
end;
$$;

do $$
declare
  signature text;
begin
  foreach signature in array array[
    'public.skie_enqueue_notification(text,text,uuid,text,text,text,uuid,jsonb,text,integer)',
    'public.skie_claim_notification_batch(text,text,integer,integer)',
    'public.skie_finish_notification(uuid,text,text,text,text,integer)',
    'public.skie_manage_notification(uuid,text,uuid)'
  ] loop
    execute format('revoke all on function %s from public,anon,authenticated', signature);
    execute format('grant execute on function %s to service_role', signature);
  end loop;
end;
$$;

commit;
