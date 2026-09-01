-- Keep the atomic checkout sales guard aligned with the supported event ticket modes.
-- The Phase 3 guard predates post_checkout_approval and therefore marked those
-- events closed even while the public application checkout page was available.

begin;

create or replace function public.skie_event_sales_enabled(p_event jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(p_event ->> 'lifecycle','') = 'published'
    and coalesce(p_event ->> 'visibility','') in ('public','private_link','password')
    and coalesce(p_event ->> 'ticketMode','') in (
      'invite_only',
      'direct_purchase',
      'free_rsvp',
      'post_checkout_approval'
    );
$$;

-- Reconcile all existing event control rows from the authoritative live site
-- document. Preserve the original actor and document version because this is a
-- compatibility repair, not an admin-authored CMS state change.
with current_events as (
  select event.value as payload
  from public.platform_documents as document
  cross join lateral jsonb_array_elements(
    coalesce(document.payload -> 'events', '[]'::jsonb)
  ) as event(value)
  where document.key = 'site'
)
update public.event_sale_controls as control
set sales_enabled = public.skie_event_sales_enabled(current_events.payload),
    state_signature = concat_ws(
      '|',
      current_events.payload ->> 'lifecycle',
      current_events.payload ->> 'visibility',
      current_events.payload ->> 'ticketMode'
    ),
    updated_at = now()
from current_events
where control.event_id = current_events.payload ->> 'id';

commit;
