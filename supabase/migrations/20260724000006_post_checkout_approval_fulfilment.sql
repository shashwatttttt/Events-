-- Mark the post-checkout workflow complete only after the normalized order
-- has reached fulfilled and its tickets have been created.

begin;

create or replace function public.skie_mark_post_checkout_fulfilled(
  p_order_id uuid
)
returns table(application_id uuid, order_id uuid, duplicate boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_application public.post_checkout_applications%rowtype;
  v_order public.orders%rowtype;
  v_duplicate boolean := false;
  v_valid_ticket_count integer;
begin
  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then raise exception 'POST_APPROVAL_ORDER_NOT_FOUND'; end if;
  if v_order.checkout_mode <> 'post_checkout_approval' then
    raise exception 'POST_APPROVAL_MODE_MISMATCH';
  end if;
  if v_order.status <> 'fulfilled' then
    raise exception 'POST_APPROVAL_ORDER_NOT_FULFILLED';
  end if;

  select * into v_application
  from public.post_checkout_applications
  where order_id = p_order_id
  for update;

  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.payment_status <> 'captured' then
    raise exception 'POST_APPROVAL_PAYMENT_NOT_CAPTURED';
  end if;
  if v_application.status not in ('approved','approved_override') then
    raise exception 'POST_APPROVAL_APPLICATION_NOT_APPROVED';
  end if;

  select count(*) into v_valid_ticket_count
  from public.tickets
  where order_id = p_order_id and status = 'valid';

  if v_valid_ticket_count < 1 then
    raise exception 'POST_APPROVAL_NO_VALID_TICKETS';
  end if;

  if v_order.workflow_status = 'fulfilled' then
    v_duplicate := true;
  else
    update public.orders
    set workflow_status = 'fulfilled',
        state_version = state_version + 1
    where id = p_order_id;

    insert into public.post_checkout_audit_events (
      application_id,order_id,action,safe_metadata
    ) values (
      v_application.id,p_order_id,'post_checkout.fulfilled',
      jsonb_build_object('validTicketCount',v_valid_ticket_count)
    );
  end if;

  return query select v_application.id,p_order_id,v_duplicate;
end;
$$;

revoke all on function public.skie_mark_post_checkout_fulfilled(uuid)
from public, anon, authenticated;
grant execute on function public.skie_mark_post_checkout_fulfilled(uuid)
to service_role;

commit;
