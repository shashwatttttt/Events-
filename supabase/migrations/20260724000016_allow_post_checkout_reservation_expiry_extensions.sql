-- Allow the post-checkout approval workflow to extend an active reservation deadline.
-- All commercial reservation snapshot fields remain immutable, and expiry can never move earlier.

begin;

create or replace function public.skie_reservation_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if row(
    new.reservation_key,new.version,new.customer_id,new.event_id,new.allocation_id,
    new.promo_code_id,new.currency,new.expected_subtotal_cents,new.expected_discount_cents,
    new.expected_total_cents,new.customer_email,new.customer_name,new.event_title,
    new.correlation_id,new.created_at
  ) is distinct from row(
    old.reservation_key,old.version,old.customer_id,old.event_id,old.allocation_id,
    old.promo_code_id,old.currency,old.expected_subtotal_cents,old.expected_discount_cents,
    old.expected_total_cents,old.customer_email,old.customer_name,old.event_title,
    old.correlation_id,old.created_at
  ) then
    raise exception using errcode = '23514', message = 'RESERVATION_SNAPSHOT_IMMUTABLE';
  end if;

  if new.expires_at is distinct from old.expires_at then
    if new.expires_at < old.expires_at
      or old.status not in ('reserved','session_active')
      or new.status not in ('reserved','session_active') then
      raise exception using errcode = '23514', message = 'RESERVATION_EXPIRY_EXTENSION_INVALID';
    end if;
  end if;

  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.skie_reservation_immutable()
from public, anon, authenticated;

commit;
