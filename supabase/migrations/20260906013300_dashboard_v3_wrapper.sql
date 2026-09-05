begin;

alter function public.get_my_dashboard_v3() rename to get_my_dashboard_payload_v3;

revoke all on function public.get_my_dashboard_payload_v3() from public, anon, authenticated;

create or replace function public.get_my_dashboard_v3()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.sync_my_timesheet_v3();
  return public.get_my_dashboard_payload_v3();
end;
$$;

revoke all on function public.get_my_dashboard_v3() from public, anon;
grant execute on function public.get_my_dashboard_v3() to authenticated;

commit;
