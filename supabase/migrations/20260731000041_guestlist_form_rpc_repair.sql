-- Repair guest-list application draft/save and submit RPCs.
-- Explicit table aliases remove runtime ambiguity between RETURN TABLE output
-- variables (notably state_version) and columns with the same names.

begin;

create or replace function public.skie_save_post_checkout_draft(
  p_order_id uuid,
  p_customer_id uuid,
  p_answers jsonb,
  p_completion_percentage integer,
  p_expected_state_version integer
)
returns table(application_id uuid, state_version integer, saved_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_application public.post_checkout_applications%rowtype;
begin
  if jsonb_typeof(p_answers) <> 'object' then
    raise exception using errcode = '22023', message = 'POST_APPROVAL_ANSWERS_INVALID';
  end if;

  select application_row.*
  into v_application
  from public.post_checkout_applications as application_row
  where application_row.order_id = p_order_id
    and application_row.customer_id = p_customer_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'POST_APPROVAL_APPLICATION_NOT_FOUND';
  end if;
  if v_application.state_version <> p_expected_state_version then
    raise exception using errcode = 'P0001', message = 'POST_APPROVAL_STALE_VERSION';
  end if;
  if v_application.status not in ('awaiting_form','draft')
    or v_application.payment_status not in ('authorized','not_required') then
    raise exception using errcode = 'P0001', message = 'POST_APPROVAL_FORM_NOT_EDITABLE';
  end if;
  if now() >= v_application.form_due_at then
    raise exception using errcode = 'P0001', message = 'POST_APPROVAL_FORM_EXPIRED';
  end if;

  update public.post_checkout_applications as application_row
  set draft_answers = p_answers,
      completion_percentage = greatest(0,least(100,p_completion_percentage)),
      status = 'draft',
      last_activity_at = now(),
      state_version = application_row.state_version + 1
  where application_row.id = v_application.id
  returning application_row.* into v_application;

  update public.orders as order_row
  set workflow_status = 'form_draft',
      state_version = order_row.state_version + 1
  where order_row.id = p_order_id
    and order_row.workflow_status in ('awaiting_form','form_draft');

  return query
  select v_application.id, v_application.state_version, v_application.updated_at;
end;
$$;

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
set search_path = public, pg_catalog
as $$
declare
  v_application public.post_checkout_applications%rowtype;
begin
  if jsonb_typeof(p_answers) <> 'object' then
    raise exception using errcode = '22023', message = 'POST_APPROVAL_ANSWERS_INVALID';
  end if;
  if p_review_due_at <= now() then
    raise exception using errcode = 'P0001', message = 'POST_APPROVAL_REVIEW_DEADLINE_INVALID';
  end if;

  select application_row.*
  into v_application
  from public.post_checkout_applications as application_row
  where application_row.order_id = p_order_id
    and application_row.customer_id = p_customer_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'POST_APPROVAL_APPLICATION_NOT_FOUND';
  end if;
  if v_application.state_version <> p_expected_state_version then
    raise exception using errcode = 'P0001', message = 'POST_APPROVAL_STALE_VERSION';
  end if;
  if v_application.status not in ('awaiting_form','draft')
    or v_application.payment_status not in ('authorized','not_required') then
    raise exception using errcode = 'P0001', message = 'POST_APPROVAL_FORM_NOT_SUBMITTABLE';
  end if;
  if now() >= v_application.form_due_at then
    raise exception using errcode = 'P0001', message = 'POST_APPROVAL_FORM_EXPIRED';
  end if;
  if v_application.payment_status = 'authorized'
    and v_application.capture_before is not null
    and p_review_due_at >= v_application.capture_before - interval '60 minutes' then
    raise exception using errcode = 'P0001', message = 'POST_APPROVAL_REVIEW_DEADLINE_TOO_LATE';
  end if;

  update public.post_checkout_applications as application_row
  set draft_answers = p_answers,
      submitted_answers = p_answers,
      completion_percentage = greatest(0,least(100,p_completion_percentage)),
      status = 'submitted',
      submitted_at = now(),
      review_due_at = p_review_due_at,
      next_reminder_at = null,
      last_activity_at = now(),
      state_version = application_row.state_version + 1
  where application_row.id = v_application.id
  returning application_row.* into v_application;

  update public.reservations as reservation_row
  set expires_at = greatest(reservation_row.expires_at,p_review_due_at)
  where reservation_row.id = v_application.reservation_id
    and reservation_row.status in ('session_active','reserved');

  if not found then
    raise exception using errcode = 'P0001', message = 'POST_APPROVAL_RESERVATION_NOT_ACTIVE';
  end if;

  update public.orders as order_row
  set workflow_status = 'under_review',
      state_version = order_row.state_version + 1
  where order_row.id = p_order_id
    and order_row.status in ('reserved','checkout_pending');

  if not found then
    raise exception using errcode = 'P0001', message = 'POST_APPROVAL_ORDER_NOT_PREPARABLE';
  end if;

  return query
  select v_application.id, v_application.state_version, v_application.submitted_at;
end;
$$;

revoke all on function public.skie_save_post_checkout_draft(uuid,uuid,jsonb,integer,integer)
from public, anon, authenticated;
revoke all on function public.skie_submit_post_checkout_application(uuid,uuid,jsonb,integer,integer,timestamptz)
from public, anon, authenticated;

grant execute on function public.skie_save_post_checkout_draft(uuid,uuid,jsonb,integer,integer)
to service_role;
grant execute on function public.skie_submit_post_checkout_application(uuid,uuid,jsonb,integer,integer,timestamptz)
to service_role;

notify pgrst, 'reload schema';
commit;
