-- Repair the mandatory post-checkout application submit transition.
-- Recreate the exact PostgREST-visible signature, qualify every mutable column,
-- preserve the existing payment hold and force the API schema cache to reload.

begin;

create or replace function public.skie_submit_post_checkout_application(
  p_order_id uuid,
  p_customer_id uuid,
  p_answers jsonb,
  p_completion_percentage integer,
  p_expected_state_version integer,
  p_review_due_at timestamptz
)
returns table(application_id uuid, state_version integer, submitted_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_application public.post_checkout_applications%rowtype;
  v_reservation public.reservations%rowtype;
begin
  if jsonb_typeof(p_answers) <> 'object' then
    raise exception 'POST_APPROVAL_ANSWERS_INVALID';
  end if;
  if p_review_due_at is null or p_review_due_at <= now() then
    raise exception 'POST_APPROVAL_REVIEW_DEADLINE_INVALID';
  end if;

  select pca.* into v_application
  from public.post_checkout_applications as pca
  where pca.order_id = p_order_id
    and pca.customer_id = p_customer_id
  for update;

  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.state_version <> p_expected_state_version then
    raise exception 'POST_APPROVAL_STALE_VERSION';
  end if;
  if v_application.status not in ('awaiting_form','draft')
    or v_application.payment_status <> 'authorized' then
    raise exception 'POST_APPROVAL_FORM_NOT_SUBMITTABLE';
  end if;
  if now() >= v_application.form_due_at then
    raise exception 'POST_APPROVAL_FORM_EXPIRED';
  end if;
  if v_application.capture_before is not null
    and p_review_due_at >= v_application.capture_before - interval '60 minutes' then
    raise exception 'POST_APPROVAL_REVIEW_DEADLINE_TOO_LATE';
  end if;

  select r.* into v_reservation
  from public.reservations as r
  where r.id = v_application.reservation_id
  for update;

  if not found or v_reservation.status not in ('session_active','reserved') then
    raise exception 'POST_APPROVAL_RESERVATION_NOT_ACTIVE';
  end if;

  update public.post_checkout_applications as pca
  set draft_answers = p_answers,
      submitted_answers = p_answers,
      completion_percentage = greatest(0, least(100, p_completion_percentage)),
      status = 'submitted',
      submitted_at = now(),
      review_due_at = p_review_due_at,
      next_reminder_at = null,
      last_activity_at = now(),
      state_version = pca.state_version + 1,
      failure_code = null
  where pca.id = v_application.id
  returning pca.* into v_application;

  update public.reservations as r
  set expires_at = greatest(r.expires_at, p_review_due_at)
  where r.id = v_application.reservation_id;

  update public.orders as o
  set workflow_status = 'under_review',
      state_version = o.state_version + 1
  where o.id = p_order_id;

  if not found then raise exception 'POST_APPROVAL_ORDER_NOT_FOUND'; end if;

  return query
  select v_application.id, v_application.state_version, v_application.submitted_at;
end;
$$;

revoke all on function public.skie_submit_post_checkout_application(
  uuid,uuid,jsonb,integer,integer,timestamptz
) from public, anon, authenticated;

grant execute on function public.skie_submit_post_checkout_application(
  uuid,uuid,jsonb,integer,integer,timestamptz
) to service_role;

-- Supabase PostgREST listens for this and refreshes its RPC schema after commit.
notify pgrst, 'reload schema';

commit;
