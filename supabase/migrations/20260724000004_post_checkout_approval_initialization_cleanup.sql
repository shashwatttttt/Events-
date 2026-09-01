-- Release the active-application guard when Stripe Checkout creation fails.

begin;

create or replace function public.skie_fail_post_checkout_initialization(
  p_order_id uuid,
  p_failure_code text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_application public.post_checkout_applications%rowtype;
begin
  select * into v_application
  from public.post_checkout_applications
  where order_id = p_order_id
  for update;

  if not found then return; end if;
  if v_application.status <> 'awaiting_authorization' then return; end if;

  update public.post_checkout_applications
  set status = 'rejected',
      payment_status = 'failed',
      failure_code = left(coalesce(p_failure_code,'CHECKOUT_INITIALIZATION_FAILED'),120),
      next_reminder_at = null,
      state_version = state_version + 1
  where id = v_application.id;

  update public.orders
  set workflow_status = 'payment_failed',
      state_version = state_version + 1
  where id = p_order_id;

  insert into public.post_checkout_audit_events (
    application_id,order_id,action,safe_metadata
  ) values (
    v_application.id,p_order_id,'post_checkout.initialization_failed',
    jsonb_build_object('failureCode',left(coalesce(p_failure_code,'CHECKOUT_INITIALIZATION_FAILED'),120))
  );
end;
$$;

revoke all on function public.skie_fail_post_checkout_initialization(uuid,text)
from public, anon, authenticated;
grant execute on function public.skie_fail_post_checkout_initialization(uuid,text)
to service_role;

commit;
