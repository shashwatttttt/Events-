-- SKIE EVENTS launch Phase 3: privacy-conscious first-party analytics.
-- Forward-only, additive, and non-blocking for operational workflows.

begin;

create table public.analytics_retention_settings (
  singleton boolean primary key default true check (singleton),
  retention_days integer not null default 400 check (retention_days between 30 and 2555),
  updated_by uuid references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now()
);
insert into public.analytics_retention_settings(singleton,retention_days) values (true,400) on conflict (singleton) do nothing;

create table public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  event_name text not null check (event_name in (
    'page_view','event_page_view','application_started','application_completed','allocation_unlocked',
    'checkout_started','checkout_cancelled','payment_completed','payment_failed','ticket_issued',
    'promo_applied','promo_rejected','notification_queued','notification_delivered','notification_failed',
    'video_impression','video_started','video_completed','ticket_scan_accepted','ticket_scan_rejected',
    'ticket_scan_duplicate','addon_redemption','addon_redemption_reversal'
  )),
  source text not null check (source in ('client','server')),
  deduplication_key text not null unique check (length(deduplication_key) between 6 and 200),
  event_id text check (event_id is null or length(event_id) between 1 and 120),
  ticket_type_id text check (ticket_type_id is null or length(ticket_type_id) between 1 and 120),
  promo_code_id uuid references public.promo_codes(id) on delete restrict,
  notification_channel text check (notification_channel is null or notification_channel in ('email','sms','in_app','whatsapp')),
  utm_source text check (utm_source is null or length(utm_source) between 1 and 100),
  utm_medium text check (utm_medium is null or length(utm_medium) between 1 and 100),
  utm_campaign text check (utm_campaign is null or length(utm_campaign) between 1 and 100),
  referrer_category text check (referrer_category is null or referrer_category in ('direct','search','social','email','partner','internal','other')),
  device_category text check (device_category is null or device_category in ('mobile','tablet','desktop','other')),
  browser_family text check (browser_family is null or browser_family in ('chrome','safari','firefox','edge','other')),
  anonymous_session_hash text check (anonymous_session_hash is null or anonymous_session_hash ~ '^[a-f0-9]{64}$'),
  customer_id uuid references public.profiles(id) on delete restrict,
  revenue_cents integer check (revenue_cents is null or revenue_cents >= 0),
  quantity integer check (quantity is null or quantity >= 0),
  safe_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_metadata)='object' and pg_column_size(safe_metadata)<=8192),
  occurred_at timestamptz not null,
  melbourne_date date not null,
  retention_until date not null,
  created_at timestamptz not null default now()
);

create index analytics_events_event_date_idx on public.analytics_events(event_id,melbourne_date,event_name);
create index analytics_events_type_date_idx on public.analytics_events(event_name,melbourne_date);
create index analytics_events_campaign_date_idx on public.analytics_events(utm_campaign,melbourne_date) where utm_campaign is not null;
create index analytics_events_channel_date_idx on public.analytics_events(notification_channel,melbourne_date) where notification_channel is not null;
create index analytics_events_retention_idx on public.analytics_events(retention_until);

alter table public.analytics_events enable row level security;
alter table public.analytics_retention_settings enable row level security;
revoke all on table public.analytics_events,public.analytics_retention_settings from public,anon,authenticated;
grant select,insert,update,delete on table public.analytics_events,public.analytics_retention_settings to service_role;

create function public.skie_analytics_safe_text(value text, maximum integer)
returns text language sql immutable set search_path=public
as $$ select nullif(left(regexp_replace(trim(coalesce(value,'')),'[^A-Za-z0-9 ._:/-]+','','g'),maximum),'') $$;

create function public.skie_capture_analytics_event(
  p_event_name text,p_source text,p_deduplication_key text,p_occurred_at timestamptz,
  p_event_id text,p_ticket_type_id text,p_promo_code_id uuid,p_notification_channel text,
  p_utm_source text,p_utm_medium text,p_utm_campaign text,p_referrer_category text,
  p_device_category text,p_browser_family text,p_anonymous_session_hash text,p_customer_id uuid,
  p_revenue_cents integer,p_quantity integer,p_safe_metadata jsonb
)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare v_id uuid; v_retention integer; v_occurred timestamptz := coalesce(p_occurred_at,now());
begin
  if p_event_name not in (
    'page_view','event_page_view','application_started','application_completed','allocation_unlocked','checkout_started',
    'checkout_cancelled','payment_completed','payment_failed','ticket_issued','promo_applied','promo_rejected',
    'notification_queued','notification_delivered','notification_failed','video_impression','video_started',
    'video_completed','ticket_scan_accepted','ticket_scan_rejected','ticket_scan_duplicate','addon_redemption','addon_redemption_reversal'
  ) or p_source not in ('client','server') or length(trim(p_deduplication_key)) not between 6 and 200 then
    raise exception using errcode='22023',message='INVALID_ANALYTICS_EVENT';
  end if;
  if p_source='client' and p_event_name in ('allocation_unlocked','application_completed','checkout_started','payment_completed','payment_failed','ticket_issued','promo_applied','notification_queued','notification_delivered','notification_failed','ticket_scan_accepted','ticket_scan_rejected','ticket_scan_duplicate','addon_redemption','addon_redemption_reversal') then
    raise exception using errcode='42501',message='ANALYTICS_SERVER_AUTHORITY_REQUIRED';
  end if;
  if jsonb_typeof(coalesce(p_safe_metadata,'{}'))<>'object' or pg_column_size(coalesce(p_safe_metadata,'{}'))>8192
    or coalesce(p_safe_metadata,'{}')::text ~* '"[^"}]*(email|phone|address|card|secret|token|password|provider.payload|raw.payload|ip.address|user.agent)[^"}]*"\s*:' then
    raise exception using errcode='22023',message='UNSAFE_ANALYTICS_METADATA';
  end if;
  if p_anonymous_session_hash is not null and p_anonymous_session_hash !~ '^[a-f0-9]{64}$' then raise exception using errcode='22023',message='INVALID_ANALYTICS_SESSION'; end if;
  select retention_days into v_retention from public.analytics_retention_settings where singleton=true;
  insert into public.analytics_events(event_name,source,deduplication_key,event_id,ticket_type_id,promo_code_id,notification_channel,
    utm_source,utm_medium,utm_campaign,referrer_category,device_category,browser_family,anonymous_session_hash,customer_id,
    revenue_cents,quantity,safe_metadata,occurred_at,melbourne_date,retention_until)
  values (p_event_name,p_source,trim(p_deduplication_key),public.skie_analytics_safe_text(p_event_id,120),public.skie_analytics_safe_text(p_ticket_type_id,120),p_promo_code_id,p_notification_channel,
    public.skie_analytics_safe_text(p_utm_source,100),public.skie_analytics_safe_text(p_utm_medium,100),public.skie_analytics_safe_text(p_utm_campaign,100),p_referrer_category,p_device_category,p_browser_family,p_anonymous_session_hash,p_customer_id,
    p_revenue_cents,p_quantity,coalesce(p_safe_metadata,'{}'),v_occurred,(v_occurred at time zone 'Australia/Melbourne')::date,(v_occurred at time zone 'Australia/Melbourne')::date+coalesce(v_retention,400))
  on conflict (deduplication_key) do nothing returning id into v_id;
  return jsonb_build_object('accepted',true,'inserted',v_id is not null,'eventId',v_id);
end;
$$;

create function public.skie_analytics_report(p_start_date date,p_end_date date,p_event_id text,p_campaign text,p_channel text)
returns jsonb language sql stable security definer set search_path=public
as $$
with filtered as (
  select * from public.analytics_events where melbourne_date between p_start_date and p_end_date
    and (p_event_id is null or event_id=p_event_id) and (p_campaign is null or utm_campaign=p_campaign)
    and (p_channel is null or notification_channel=p_channel)
), grouped_type as (
  select event_name,count(*)::integer count,coalesce(sum(revenue_cents),0)::bigint revenue_cents,coalesce(sum(quantity),0)::bigint quantity from filtered group by event_name
), grouped_date as (
  select melbourne_date,count(*)::integer count,coalesce(sum(revenue_cents),0)::bigint revenue_cents from filtered group by melbourne_date order by melbourne_date
)
select jsonb_build_object(
  'startDate',p_start_date,'endDate',p_end_date,
  'totals',jsonb_build_object('events',(select count(*) from filtered),'revenueCents',(select coalesce(sum(revenue_cents),0) from filtered where event_name='payment_completed'),'ticketQuantity',(select coalesce(sum(quantity),0) from filtered where event_name='ticket_issued')),
  'byEventType',coalesce((select jsonb_agg(jsonb_build_object('eventName',event_name,'count',count,'revenueCents',revenue_cents,'quantity',quantity) order by event_name) from grouped_type),'[]'),
  'byDate',coalesce((select jsonb_agg(jsonb_build_object('date',melbourne_date,'count',count,'revenueCents',revenue_cents) order by melbourne_date) from grouped_date),'[]')
) $$;

create function public.skie_prune_analytics_events(p_before date)
returns integer language plpgsql security definer set search_path=public
as $$ declare v_count integer; begin delete from public.analytics_events where retention_until < coalesce(p_before,(now() at time zone 'Australia/Melbourne')::date); get diagnostics v_count=row_count; return v_count; end $$;

create function public.skie_analytics_operational_trigger()
returns trigger language plpgsql security definer set search_path=public
as $$
declare v_name text; v_key text; v_event text; v_ticket text; v_promo uuid; v_channel text; v_customer uuid; v_revenue integer; v_quantity integer; v_time timestamptz;
begin
  begin
    if tg_table_name='ticket_allocations' and (tg_op='INSERT' or old.status is distinct from new.status) and new.status='unlocked' then v_name:='allocation_unlocked';v_key:='allocation_unlocked:'||new.id;v_event:=new.event_id;v_ticket:=new.ticket_type_id;v_customer:=new.customer_id;v_time:=new.updated_at;
    elsif tg_table_name='orders' and tg_op='INSERT' then v_name:='checkout_started';v_key:='checkout_started:'||new.id;v_event:=new.event_id;v_customer:=new.customer_id;v_time:=new.created_at;
    elsif tg_table_name='orders' and old.status is distinct from new.status and new.status in ('cancelled','expired','failed') then v_name:='checkout_cancelled';v_key:='checkout_cancelled:'||new.id||':'||new.status;v_event:=new.event_id;v_customer:=new.customer_id;v_time:=new.updated_at;
    elsif tg_table_name='payments' and (tg_op='INSERT' or old.status is distinct from new.status) and new.status in ('payment_received','paid') then v_name:='payment_completed';v_key:='payment_completed:'||new.order_id;select event_id,customer_id into v_event,v_customer from public.orders where id=new.order_id;v_revenue:=new.amount_cents;v_time:=coalesce(new.provider_created_at,new.updated_at);
    elsif tg_table_name='payments' and (tg_op='INSERT' or old.status is distinct from new.status) and new.status in ('failed','cancelled') then v_name:='payment_failed';v_key:='payment_failed:'||new.id||':'||new.status;select event_id,customer_id into v_event,v_customer from public.orders where id=new.order_id;v_time:=new.updated_at;
    elsif tg_table_name='tickets' and tg_op='INSERT' then v_name:='ticket_issued';v_key:='ticket_issued:'||new.id;v_event:=new.event_id;v_ticket:=new.ticket_type_id;v_customer:=new.customer_id;v_quantity:=1;v_time:=new.created_at;
    elsif tg_table_name='promo_redemptions' and tg_op='INSERT' then v_name:='promo_applied';v_key:='promo_applied:'||coalesce(new.order_id::text,new.reservation_id::text);v_event:=new.event_id;v_promo:=new.promo_code_id;v_customer:=new.customer_id;v_quantity:=new.discounted_ticket_units;v_time:=new.created_at;
    elsif tg_table_name='notification_outbox' and tg_op='INSERT' then v_name:='notification_queued';v_key:='notification_queued:'||new.id;v_event:=new.event_id;v_channel:=new.channel;v_customer:=new.recipient_user_id;v_quantity:=1;v_time:=new.created_at;
    elsif tg_table_name='notification_outbox' and old.status is distinct from new.status and new.status='delivered' then v_name:='notification_delivered';v_key:='notification_delivered:'||new.id;v_event:=new.event_id;v_channel:=new.channel;v_customer:=new.recipient_user_id;v_quantity:=1;v_time:=new.updated_at;
    elsif tg_table_name='notification_outbox' and old.status is distinct from new.status and new.status='failed' then v_name:='notification_failed';v_key:='notification_failed:'||new.id;v_event:=new.event_id;v_channel:=new.channel;v_customer:=new.recipient_user_id;v_quantity:=1;v_time:=new.updated_at;
    elsif tg_table_name='check_ins' and tg_op='INSERT' then v_name:=case when new.result='valid' then 'ticket_scan_accepted' when new.result='already_checked_in' then 'ticket_scan_duplicate' else 'ticket_scan_rejected' end;v_key:=v_name||':'||new.id;v_event:=new.event_id;v_quantity:=1;v_time:=new.scanned_at;
    elsif tg_table_name='entitlement_redemptions' and tg_op='INSERT' then v_name:='addon_redemption';v_key:='addon_redemption:'||new.idempotency_key;v_event:=new.event_id;v_quantity:=new.quantity;v_time:=new.redeemed_at;
    else return new; end if;
    perform public.skie_capture_analytics_event(v_name,'server',v_key,v_time,v_event,v_ticket,v_promo,v_channel,null,null,null,null,null,null,null,v_customer,v_revenue,v_quantity,'{}');
  exception when others then null;
  end;
  return new;
end;
$$;

create trigger analytics_allocations after insert or update of status on public.ticket_allocations for each row execute function public.skie_analytics_operational_trigger();
create trigger analytics_orders after insert or update of status on public.orders for each row execute function public.skie_analytics_operational_trigger();
create trigger analytics_payments after insert or update of status on public.payments for each row execute function public.skie_analytics_operational_trigger();
create trigger analytics_tickets after insert on public.tickets for each row execute function public.skie_analytics_operational_trigger();
create trigger analytics_promos after insert on public.promo_redemptions for each row execute function public.skie_analytics_operational_trigger();
create trigger analytics_notifications after insert or update of status on public.notification_outbox for each row execute function public.skie_analytics_operational_trigger();
create trigger analytics_check_ins after insert on public.check_ins for each row execute function public.skie_analytics_operational_trigger();
create trigger analytics_redemptions after insert on public.entitlement_redemptions for each row execute function public.skie_analytics_operational_trigger();

revoke all on function public.skie_analytics_safe_text(text,integer),public.skie_capture_analytics_event(text,text,text,timestamp with time zone,text,text,uuid,text,text,text,text,text,text,text,text,uuid,integer,integer,jsonb),public.skie_analytics_report(date,date,text,text,text),public.skie_prune_analytics_events(date),public.skie_analytics_operational_trigger() from public,anon,authenticated;
grant execute on function public.skie_capture_analytics_event(text,text,text,timestamp with time zone,text,text,uuid,text,text,text,text,text,text,text,text,uuid,integer,integer,jsonb),public.skie_analytics_report(date,date,text,text,text),public.skie_prune_analytics_events(date) to service_role;

commit;
