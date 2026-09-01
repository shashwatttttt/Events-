-- Follow-up hardening for the post-checkout approval foundation.
-- Adds a dedicated immutable audit table and replaces the deadline RPC so it
-- does not depend on the JSON document audit log.

begin;

create table if not exists public.post_checkout_audit_events (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references public.post_checkout_applications(id) on delete restrict,
  order_id uuid references public.orders(id) on delete restrict,
  actor_id uuid references public.profiles(id) on delete restrict,
  action text not null check (length(action) between 3 and 160),
  safe_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists post_checkout_audit_application_idx
  on public.post_checkout_audit_events(application_id, created_at desc);
create index if not exists post_checkout_audit_order_idx
  on public.post_checkout_audit_events(order_id, created_at desc);

alter table public.post_checkout_audit_events enable row level security;
revoke all on public.post_checkout_audit_events from public, anon, authenticated;

grant select, insert, update, delete on public.post_checkout_applications to service_role;
grant select, insert on public.post_checkout_decisions to service_role;
grant select, insert, update on public.post_checkout_payment_actions to service_role;
grant select, insert on public.post_checkout_audit_events to service_role;

drop trigger if exists post_checkout_applications_touch_updated_at on public.post_checkout_applications;
create trigger post_checkout_applications_touch_updated_at
before update on public.post_checkout_applications
for each row execute function public.skie_touch_updated_at();

drop trigger if exists post_checkout_payment_actions_touch_updated_at on public.post_checkout_payment_actions;
create trigger post_checkout_payment_actions_touch_updated_at
before update on public.post_checkout_payment_actions
for each row execute function public.skie_touch_updated_at();

create or replace function public.skie_extend_post_checkout_form_deadline(
  p_application_id uuid,
  p_actor_id uuid,
  p_form_due_at timestamptz
)
returns table(application_id uuid, form_due_at timestamptz, state_version integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_application public.post_checkout_applications%rowtype;
begin
  select * into v_application
  from public.post_checkout_applications
  where id = p_application_id
  for update;

  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.status not in ('awaiting_form','draft') or v_application.payment_status <> 'authorized' then
    raise exception 'POST_APPROVAL_DEADLINE_NOT_EXTENDABLE';
  end if;
  if p_form_due_at <= now() then raise exception 'POST_APPROVAL_FORM_DEADLINE_INVALID'; end if;
  if v_application.capture_before is not null
    and p_form_due_at >= v_application.capture_before - interval '60 minutes' then
    raise exception 'POST_APPROVAL_FORM_DEADLINE_TOO_LATE';
  end if;

  update public.post_checkout_applications
  set form_due_at = p_form_due_at,
      next_reminder_at = least(p_form_due_at, now() + interval '10 minutes'),
      state_version = state_version + 1
  where id = v_application.id
  returning * into v_application;

  insert into public.post_checkout_audit_events (
    application_id, order_id, actor_id, action, safe_metadata
  ) values (
    v_application.id,
    v_application.order_id,
    p_actor_id,
    'post_checkout.form_deadline_extended',
    jsonb_build_object('formDueAt', p_form_due_at)
  );

  return query
  select v_application.id, v_application.form_due_at, v_application.state_version;
end;
$$;

revoke all on function public.skie_extend_post_checkout_form_deadline(uuid,uuid,timestamptz)
  from public, anon, authenticated;
grant execute on function public.skie_extend_post_checkout_form_deadline(uuid,uuid,timestamptz)
  to service_role;

commit;
