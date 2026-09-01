-- Provide complete, code-specific promo usage counts without loading a global
-- redemption slice into the application. The application retains a paged
-- fallback so this migration can roll out without a checkout outage.

begin;

create index if not exists promo_redemptions_usage_lookup_idx
on public.promo_redemptions (promo_code_id, status, reserved_until, customer_id);

create or replace function public.skie_promo_usage_snapshot(
  p_promo_code_id uuid,
  p_customer_id uuid
)
returns table(
  redemptions bigint,
  discounted_ticket_units bigint,
  customer_redemptions bigint
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select
    count(*)::bigint as redemptions,
    coalesce(sum(pr.discounted_ticket_units), 0)::bigint as discounted_ticket_units,
    count(*) filter (where pr.customer_id = p_customer_id)::bigint as customer_redemptions
  from public.promo_redemptions as pr
  where pr.promo_code_id = p_promo_code_id
    and pr.status in ('reserved', 'finalized', 'refunded', 'disputed')
    and not (
      pr.status = 'reserved'
      and pr.reserved_until <= now()
    );
$$;

revoke all on function public.skie_promo_usage_snapshot(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.skie_promo_usage_snapshot(uuid, uuid)
to service_role;

notify pgrst, 'reload schema';

commit;
