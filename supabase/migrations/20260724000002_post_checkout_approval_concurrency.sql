-- Concurrency and queue hardening for post-checkout approval.

begin;

create unique index if not exists post_checkout_one_active_customer_event
on public.post_checkout_applications(customer_id, event_id)
where status in (
  'awaiting_authorization','awaiting_form','draft','submitted','under_review',
  'capture_pending','approved','approved_override','rejection_pending','manual_review'
);

create unique index if not exists post_checkout_one_capture_action
on public.post_checkout_payment_actions(application_id, action_type)
where action_type = 'capture';

create unique index if not exists post_checkout_one_cancel_action
on public.post_checkout_payment_actions(application_id, action_type)
where action_type = 'cancel';

create or replace function public.skie_claim_post_checkout_payment_actions(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 60
)
returns setof public.post_checkout_payment_actions
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidates as (
    select id
    from public.post_checkout_payment_actions
    where status in ('requested','retry')
      and available_at <= now()
      and (lease_expires_at is null or lease_expires_at <= now())
    order by created_at
    for update skip locked
    limit greatest(1,least(p_limit,25))
  )
  update public.post_checkout_payment_actions action
  set status = 'processing',
      lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(secs => greatest(30,least(p_lease_seconds,300))),
      attempt_count = action.attempt_count + 1,
      last_attempt_at = now()
  from candidates
  where action.id = candidates.id
  returning action.*;
end;
$$;

revoke all on function public.skie_claim_post_checkout_payment_actions(text,integer,integer)
from public, anon, authenticated;
grant execute on function public.skie_claim_post_checkout_payment_actions(text,integer,integer)
to service_role;

commit;
