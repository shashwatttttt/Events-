begin;

create or replace function public.skie_get_post_checkout_application_counts()
returns table (
  total_count bigint,
  pending_review_count bigint
)
language sql
security definer
set search_path = public
as $function$
  select
    count(*)::bigint as total_count,
    count(*) filter (
      where application.status in ('submitted', 'under_review', 'manual_review')
    )::bigint as pending_review_count
  from public.post_checkout_applications application
  join public.profiles customer on customer.id = application.customer_id
  where customer.admin_deleted_at is null;
$function$;

revoke all on function public.skie_get_post_checkout_application_counts() from public;
revoke all on function public.skie_get_post_checkout_application_counts() from anon;
revoke all on function public.skie_get_post_checkout_application_counts() from authenticated;
grant execute on function public.skie_get_post_checkout_application_counts() to service_role;

commit;
