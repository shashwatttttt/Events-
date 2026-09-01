-- Allow an administrator to retry a capture/cancellation action that exhausted
-- automatic retries, without creating a second financial action.

begin;

create or replace function public.skie_retry_post_checkout_payment_action(
  p_application_id uuid,
  p_actor_id uuid
)
returns table(action_id uuid, action_type text, status text, attempt_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_application public.post_checkout_applications%rowtype;
  v_action public.post_checkout_payment_actions%rowtype;
begin
  select * into v_application
  from public.post_checkout_applications
  where id = p_application_id
  for update;

  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;

  select * into v_action
  from public.post_checkout_payment_actions
  where application_id = p_application_id
    and action_type in ('capture','cancel')
  order by created_at desc
  limit 1
  for update;

  if not found then raise exception 'POST_APPROVAL_PAYMENT_ACTION_NOT_FOUND'; end if;
  if v_action.status not in ('retry','failed','manual_review')
    and not (v_action.status = 'processing' and v_action.lease_expires_at <= now()) then
    raise exception 'POST_APPROVAL_PAYMENT_ACTION_NOT_RETRYABLE';
  end if;

  update public.post_checkout_payment_actions
  set status = 'retry',
      available_at = now(),
      lease_owner = null,
      lease_expires_at = null,
      safe_error_code = null,
      completed_at = null
  where id = v_action.id
  returning * into v_action;

  insert into public.post_checkout_audit_events (
    application_id,order_id,actor_id,action,safe_metadata
  ) values (
    v_application.id,v_application.order_id,p_actor_id,
    'post_checkout.payment_action_retried',
    jsonb_build_object(
      'paymentActionId',v_action.id,
      'actionType',v_action.action_type,
      'attemptCount',v_action.attempt_count
    )
  );

  return query
  select v_action.id,v_action.action_type,v_action.status,v_action.attempt_count;
end;
$$;

revoke all on function public.skie_retry_post_checkout_payment_action(uuid,uuid)
from public, anon, authenticated;
grant execute on function public.skie_retry_post_checkout_payment_action(uuid,uuid)
to service_role;

commit;
