begin;

create table if not exists public.meta_conversion_events (
  id uuid primary key default gen_random_uuid(),
  meta_event_id text not null unique,
  event_name text not null check (event_name in (
    'PageView', 'ViewContent', 'CompleteRegistration', 'Lead', 'InitiateCheckout', 'Purchase'
  )),
  source_event text not null check (length(source_event) between 1 and 120),
  customer_id uuid,
  skie_event_id text,
  order_id text,
  value_cents bigint check (value_cents is null or value_cents >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  quantity integer check (quantity is null or quantity >= 0),
  content_ids text[] not null default '{}',
  event_source_url text,
  fbp text,
  fbc text,
  safe_metadata jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in (
    'queued', 'sending', 'sent', 'retry', 'failed', 'skipped'
  )),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  safe_error_code text,
  response_status integer,
  events_received integer,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meta_conversion_safe_metadata_object check (jsonb_typeof(safe_metadata) = 'object'),
  constraint meta_conversion_safe_metadata_size check (pg_column_size(safe_metadata) <= 4096),
  constraint meta_conversion_no_sensitive_metadata check (
    safe_metadata::text !~* '"[^"}]*(email|phone|address|card|secret|token|password|answer|raw_payload|provider_payload|ip_address|user_agent)[^"}]*"\s*:'
  ),
  constraint meta_conversion_fbp_format check (fbp is null or fbp ~ '^fb\.[0-9]+\.[0-9]+\.[A-Za-z0-9._-]+$'),
  constraint meta_conversion_fbc_format check (fbc is null or fbc ~ '^fb\.[0-9]+\.[0-9]+\.[A-Za-z0-9._-]+$')
);

create index if not exists meta_conversion_events_queue_idx
  on public.meta_conversion_events (status, available_at, created_at)
  where status in ('queued', 'sending', 'retry');
create index if not exists meta_conversion_events_order_idx
  on public.meta_conversion_events (order_id, created_at desc)
  where order_id is not null;
create index if not exists meta_conversion_events_customer_idx
  on public.meta_conversion_events (customer_id, created_at desc)
  where customer_id is not null;
create index if not exists meta_conversion_events_occurred_idx
  on public.meta_conversion_events (occurred_at desc);

alter table public.meta_conversion_events enable row level security;
revoke all on table public.meta_conversion_events from public, anon, authenticated;
grant all on table public.meta_conversion_events to service_role;

create or replace function public.skie_claim_meta_conversion_events(
  p_limit integer default 10,
  p_worker_id text default null
)
returns setof public.meta_conversion_events
language plpgsql
security definer
set search_path = public
as $function$
begin
  update public.meta_conversion_events
  set status = 'failed',
      safe_error_code = 'META_RETRY_LIMIT_REACHED',
      updated_at = now()
  where status in ('queued', 'sending', 'retry')
    and attempt_count >= 8;

  return query
  with claimed as (
    select item.id
    from public.meta_conversion_events item
    where (
        item.status in ('queued', 'retry')
        or (
          item.status = 'sending'
          and item.last_attempt_at < now() - interval '10 minutes'
        )
      )
      and item.available_at <= now()
      and item.attempt_count < 8
    order by item.available_at, item.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 25))
  )
  update public.meta_conversion_events item
  set status = 'sending',
      attempt_count = item.attempt_count + 1,
      last_attempt_at = now(),
      updated_at = now(),
      safe_error_code = null
  from claimed
  where item.id = claimed.id
  returning item.*;
end;
$function$;

revoke all on function public.skie_claim_meta_conversion_events(integer, text) from public, anon, authenticated;
grant execute on function public.skie_claim_meta_conversion_events(integer, text) to service_role;

create or replace function public.skie_meta_ads_dashboard(
  p_since timestamptz default (now() - interval '30 days')
)
returns jsonb
language sql
security definer
set search_path = public
as $function$
  with scoped as (
    select *
    from public.meta_conversion_events
    where occurred_at >= coalesce(p_since, now() - interval '30 days')
  ), event_totals as (
    select event_name,
           count(*)::integer as total,
           count(*) filter (where status = 'sent')::integer as sent,
           count(*) filter (where status in ('queued', 'sending', 'retry'))::integer as pending,
           count(*) filter (where status = 'failed')::integer as failed,
           coalesce(sum(value_cents) filter (where status = 'sent'), 0)::bigint as value_cents
    from scoped
    group by event_name
  )
  select jsonb_build_object(
    'since', coalesce(p_since, now() - interval '30 days'),
    'totals', jsonb_build_object(
      'events', (select count(*) from scoped),
      'sent', (select count(*) from scoped where status = 'sent'),
      'pending', (select count(*) from scoped where status in ('queued', 'sending', 'retry')),
      'failed', (select count(*) from scoped where status = 'failed'),
      'purchaseValueCents', (select coalesce(sum(value_cents), 0) from scoped where event_name = 'Purchase' and status = 'sent')
    ),
    'byEvent', coalesce((
      select jsonb_agg(jsonb_build_object(
        'eventName', event_name,
        'total', total,
        'sent', sent,
        'pending', pending,
        'failed', failed,
        'valueCents', value_cents
      ) order by event_name)
      from event_totals
    ), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', recent.id,
        'metaEventId', recent.meta_event_id,
        'eventName', recent.event_name,
        'sourceEvent', recent.source_event,
        'eventId', recent.skie_event_id,
        'orderId', recent.order_id,
        'valueCents', recent.value_cents,
        'currency', recent.currency,
        'quantity', recent.quantity,
        'status', recent.status,
        'attemptCount', recent.attempt_count,
        'safeErrorCode', recent.safe_error_code,
        'responseStatus', recent.response_status,
        'eventsReceived', recent.events_received,
        'occurredAt', recent.occurred_at,
        'sentAt', recent.sent_at
      ) order by recent.occurred_at desc)
      from (
        select * from scoped order by occurred_at desc limit 50
      ) recent
    ), '[]'::jsonb)
  );
$function$;

revoke all on function public.skie_meta_ads_dashboard(timestamptz) from public, anon, authenticated;
grant execute on function public.skie_meta_ads_dashboard(timestamptz) to service_role;

-- Update the durable production Privacy Policy before advertising tracking is deployed.
-- This preserves all existing legal text and appends the disclosure only once.
update public.platform_documents document
set payload = jsonb_set(
      document.payload,
      '{legalPages}',
      (
        select jsonb_agg(
          case
            when page ->> 'slug' = 'privacy' then
              page || jsonb_build_object(
                'version', '1.1',
                'publishedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'content', rtrim(coalesce(page ->> 'content', '')) || E'\n\nAdvertising measurement and Meta Business Tools\nIf you choose “Accept advertising” in our Privacy choices notice, Skie Events uses the Meta Pixel and Meta Conversions API to measure website visits, event-page views, registrations, applications, checkout starts and completed ticket purchases; assess Facebook and Instagram advertising; improve ad delivery; and create or measure advertising audiences. Optional advertising tracking is off unless you consent, and you can later reject it through the Privacy choices control without affecting essential login, checkout, payment or ticket functions.\n\nInformation disclosed to Meta may include the page or event viewed, the conversion type and time, order value and currency for a completed purchase, Meta browser identifiers such as _fbp or _fbc, and cryptographically hashed identifiers derived from an email address, phone number or Skie customer ID for matching. Hashing does not necessarily make information anonymous. We do not send application answers, passwords, payment-card details, sensitive application content, internal notes or raw contact details through this integration. Meta may process information in countries where it or its service providers operate and handles it under its own terms and privacy practices. Contact hello@skieevents.com with privacy questions or requests.'
              )
            else page
          end
          order by ordinal
        )
        from jsonb_array_elements(document.payload -> 'legalPages') with ordinality as pages(page, ordinal)
      ),
      false
    ),
    version = document.version + 1,
    updated_at = now()
where document.key = 'site'
  and jsonb_typeof(document.payload -> 'legalPages') = 'array'
  and exists (
    select 1
    from jsonb_array_elements(document.payload -> 'legalPages') page
    where page ->> 'slug' = 'privacy'
  )
  and not exists (
    select 1
    from jsonb_array_elements(document.payload -> 'legalPages') page
    where page ->> 'slug' = 'privacy'
      and coalesce(page ->> 'content', '') ilike '%Meta Pixel%'
  );

commit;
