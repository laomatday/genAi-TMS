begin;

alter function public.refresh_tms_exceptions_v2(date, date) rename to refresh_tms_exceptions_legacy_v2;
revoke all on function public.refresh_tms_exceptions_legacy_v2(date, date) from public, anon, authenticated;

create or replace function public.refresh_tms_exceptions_v2(p_from date default null, p_to date default null)
returns integer
language sql
security definer
set search_path = ''
as $$
  select public.refresh_tms_exceptions_v3(p_from, p_to);
$$;

revoke all on function public.refresh_tms_exceptions_v2(date, date) from public, anon;
grant execute on function public.refresh_tms_exceptions_v2(date, date) to authenticated;

commit;
