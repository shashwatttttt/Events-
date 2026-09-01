-- Preserve the complete v35 readiness contract after migration 39 wraps the
-- promo reservation RPC. The wrapper may satisfy the old tracking-only guard
-- only when every other v35 check passes and the renamed standard implementation
-- still contains all three original integrity markers.

begin;

alter function public.skie_post_checkout_schema_health()
  rename to skie_post_checkout_schema_health_v35;

create or replace function public.skie_post_checkout_schema_health()
returns table(schema_version integer, ready boolean, details jsonb)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_schema_version integer;
  v_original_ready boolean;
  v_details jsonb;
  v_standard_tracking_guard boolean := false;
  v_other_checks_ready boolean := false;
begin
  select health.schema_version,health.ready,health.details
  into v_schema_version,v_original_ready,v_details
  from public.skie_post_checkout_schema_health_v35() as health;

  select coalesce(
    position('discount_type = ''tracking''' in lower(pg_get_functiondef(p.oid))) > 0
      and position('v_discount := 0' in lower(pg_get_functiondef(p.oid))) > 0
      and position('discount_allocation' in lower(pg_get_functiondef(p.oid))) > 0,
    false
  )
  into v_standard_tracking_guard
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'skie_reserve_checkout_with_promo_standard'
  limit 1;

  select coalesce(bool_and(entry.value::boolean),true)
  into v_other_checks_ready
  from jsonb_each_text(coalesce(v_details,'{}'::jsonb) - 'promoTrackingRpcGuard') as entry;

  v_details := jsonb_set(
    coalesce(v_details,'{}'::jsonb),
    '{promoTrackingRpcGuard}',
    to_jsonb(v_standard_tracking_guard),
    true
  ) || jsonb_build_object(
    'promoReservationWrapperRpc',
    to_regprocedure('public.skie_reserve_checkout_with_promo(uuid,text,text,text,text,integer,text,timestamptz,jsonb,jsonb,text,text,uuid,integer)') is not null,
    'standardPromoTrackingGuard',v_standard_tracking_guard
  );

  return query select
    v_schema_version,
    v_original_ready or (
      v_other_checks_ready
      and v_standard_tracking_guard
      and to_regprocedure('public.skie_reserve_checkout_with_promo(uuid,text,text,text,text,integer,text,timestamptz,jsonb,jsonb,text,text,uuid,integer)') is not null
    ),
    v_details;
end;
$$;

revoke all on function public.skie_post_checkout_schema_health_v35()
from public, anon, authenticated;
revoke all on function public.skie_post_checkout_schema_health()
from public, anon, authenticated;

grant execute on function public.skie_post_checkout_schema_health_v35()
to service_role;
grant execute on function public.skie_post_checkout_schema_health()
to service_role;

notify pgrst, 'reload schema';
commit;
