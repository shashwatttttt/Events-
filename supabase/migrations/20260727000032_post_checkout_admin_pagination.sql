-- Return stable, server-filtered post-checkout admin pages so unresolved work
-- cannot disappear behind a fixed global row limit.

begin;

create index if not exists post_checkout_applications_admin_page_idx
on public.post_checkout_applications (created_at desc, id desc);
create index if not exists post_checkout_payment_actions_latest_idx
on public.post_checkout_payment_actions (application_id, created_at desc, id desc);

create or replace function public.skie_list_post_checkout_admin_page(
  p_filter text default 'active',
  p_search text default '',
  p_event_id text default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 50
)
returns table(application_id uuid, created_at timestamptz, admin_bucket text)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with source_rows as (
    select
      application.id,
      application.created_at,
      application.status,
      application.payment_status,
      application.capture_before,
      application.event_id,
      coalesce(orders.status,'') as order_status,
      latest_action.action_type,
      latest_action.status as action_status,
      coalesce(latest_action.attempt_count,0) as action_attempt_count,
      coalesce(reservation.expected_subtotal_cents,orders.subtotal_cents,orders.total_cents,0) as subtotal_cents,
      coalesce(reservation.expected_discount_cents,orders.discount_cents,0) as discount_cents,
      coalesce(reservation.expected_total_cents,orders.total_cents,0) as expected_total_cents,
      coalesce(orders.total_cents,0) as total_cents,
      lower(concat_ws(' ',
        profile.first_name,
        profile.last_name,
        profile.email,
        application.event_id,
        promo.code,
        promo.internal_name
      )) as search_text
    from public.post_checkout_applications as application
    left join public.profiles as profile on profile.id = application.customer_id
    left join public.orders as orders on orders.id = application.order_id
    left join public.reservations as reservation on reservation.id = application.reservation_id
    left join public.promo_codes as promo on promo.id = reservation.promo_code_id
    left join lateral (
      select action.action_type,action.status,action.attempt_count
      from public.post_checkout_payment_actions as action
      where action.application_id = application.id
      order by action.created_at desc,action.id desc
      limit 1
    ) as latest_action on true
    where (p_event_id is null or application.event_id = p_event_id)
      and (
        trim(coalesce(p_search,'')) = ''
        or lower(concat_ws(' ',
          profile.first_name,
          profile.last_name,
          profile.email,
          application.event_id,
          promo.code,
          promo.internal_name
        )) like '%' || lower(trim(p_search)) || '%'
      )
  ), classified as (
    select
      row.*,
      row.status = 'form_expired'
        and row.payment_status = 'cancel_requested'
        and row.action_type = 'cancel'
        and row.action_status = 'requested'
        and row.action_attempt_count = 0 as recoverable_timeout,
      case
        when row.subtotal_cents - row.discount_cents <> row.total_cents
          or row.expected_total_cents <> row.total_cents
          or row.status = 'manual_review'
          or row.payment_status in ('failed','reconciliation_required')
          or row.action_status in ('failed','manual_review')
          or (row.payment_status = 'captured' and row.order_status <> 'fulfilled')
          or (
            row.status in ('approved','approved_override')
            and row.payment_status <> 'captured'
            and coalesce(row.action_status,'') not in ('requested','processing','retry')
          )
          or (
            row.status in ('rejected','form_expired','authorization_expired','withdrawn')
            and row.payment_status not in ('cancelled','expired')
            and coalesce(row.action_status,'') not in ('requested','processing','retry')
            and not (
              row.status = 'form_expired'
              and row.payment_status = 'cancel_requested'
              and row.action_type = 'cancel'
              and row.action_status = 'requested'
              and row.action_attempt_count = 0
            )
          ) then 'attention'
        when (
          row.status in ('approved','approved_override')
          and row.payment_status = 'captured'
          and row.order_status = 'fulfilled'
        ) or (
          row.status in ('rejected','form_expired','authorization_expired','withdrawn')
          and row.payment_status in ('cancelled','expired')
        ) then 'completed'
        else 'active'
      end as admin_bucket
    from source_rows as row
  ), filtered as (
    select classified.*
    from classified
    where case p_filter
      when 'attention' then classified.admin_bucket = 'attention'
      when 'completed' then classified.admin_bucket = 'completed'
      when 'needs_form' then classified.status in ('awaiting_form','draft') or classified.recoverable_timeout
      when 'review' then classified.status in ('submitted','under_review')
      when 'expiry' then classified.capture_before is not null
        and classified.capture_before <= now() + interval '12 hours'
        and classified.payment_status in ('authorized','capture_requested','cancel_requested')
        and classified.admin_bucket <> 'completed'
      when 'all' then true
      else classified.admin_bucket = 'active'
    end
  )
  select filtered.id,filtered.created_at,filtered.admin_bucket
  from filtered
  where p_cursor_created_at is null
    or filtered.created_at < p_cursor_created_at
    or (
      filtered.created_at = p_cursor_created_at
      and p_cursor_id is not null
      and filtered.id < p_cursor_id
    )
  order by filtered.created_at desc,filtered.id desc
  limit greatest(1,least(coalesce(p_limit,50),100));
$$;

revoke all on function public.skie_list_post_checkout_admin_page(text,text,text,timestamptz,uuid,integer)
from public, anon, authenticated;
grant execute on function public.skie_list_post_checkout_admin_page(text,text,text,timestamptz,uuid,integer)
to service_role;

notify pgrst, 'reload schema';

commit;
