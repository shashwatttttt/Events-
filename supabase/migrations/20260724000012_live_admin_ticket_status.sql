-- Keep live Ticketing controls on the normalized production ticket table.

begin;

create or replace function public.skie_admin_set_ticket_status(
  p_actor_id uuid,
  p_ticket_id uuid,
  p_status text,
  p_idempotency_key text
)
returns public.tickets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket public.tickets;
begin
  perform public.skie_admin_assert_actor(p_actor_id);

  if p_status not in ('valid','cancelled','entry_refused') then
    raise exception 'TICKET_STATUS_INVALID';
  end if;
  if length(trim(coalesce(p_idempotency_key,''))) < 8 then
    raise exception 'TICKET_STATUS_IDEMPOTENCY_INVALID';
  end if;

  select t.* into v_ticket
  from public.tickets as t
  where t.id = p_ticket_id
  for update;

  if not found then raise exception 'TICKET_NOT_FOUND'; end if;
  if v_ticket.status = 'refunded' then raise exception 'TICKET_REFUNDED'; end if;
  if v_ticket.status = 'checked_in' and p_status = 'valid' then
    raise exception 'CHECK_IN_REVERSAL_REQUIRED';
  end if;

  if v_ticket.status <> p_status then
    update public.tickets as t
    set status = p_status,
        checked_in_at = case when p_status = 'valid' then null else t.checked_in_at end,
        checked_in_by = case when p_status = 'valid' then null else t.checked_in_by end,
        updated_at = now()
    where t.id = p_ticket_id
    returning t.* into v_ticket;
  end if;

  perform public.skie_admin_record_operation(
    p_actor_id,
    'ticket.status.' || p_status,
    'ticket',
    p_ticket_id::text,
    null,
    p_idempotency_key,
    jsonb_build_object('eventId',v_ticket.event_id,'status',p_status)
  );

  return v_ticket;
end;
$$;

revoke all on function public.skie_admin_set_ticket_status(uuid,uuid,text,text)
from public, anon, authenticated;
grant execute on function public.skie_admin_set_ticket_status(uuid,uuid,text,text)
to service_role;

commit;
