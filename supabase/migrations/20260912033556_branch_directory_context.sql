-- Branch code -> branch name, and the org chart, were unresolvable on the client.
--
-- Defect 1: workforce_query('metadata') only returns locations that are BOTH
-- active AND inside the viewer's geofence scope, while workforce_query('directory')
-- returns every employee of the organization. Any colleague whose branch is
-- inactive or out of scope therefore has no name to resolve and the UI falls back
-- to the raw center_id ("AQX" instead of "Army Quang Xuong").
--
-- Defect 2: workforce_query('directory') never selects role or direct_manager_id,
-- so the client hardcodes role = 'Staff' and the contact org chart collapses into a
-- single "Nhan Vien" group even though the roles exist in the database.
--
-- Fix: a tenant-scoped, label-only registry that carries no geofence data
-- (no coordinates, no radius, no address), surfaced through the dashboard bundle.
-- Geofence-sensitive reads keep using metadata.locations, which is unchanged.

create or replace function public.tms_directory_context_v1()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'locations', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'center_id', l.center_id,
          'center_name', l.center_name,
          'city', l.city,
          'active', l.active
        ) order by l.center_name
      ), '[]'::jsonb)
      from public.locations l
      where l.organization_id = me.organization_id
    ),
    'people', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'employee_id', e.employee_id,
          'role', e.role,
          'direct_manager_id', e.direct_manager_id
        ) order by e.employee_id
      ), '[]'::jsonb)
      from public.employees e
      where e.organization_id = me.organization_id
        and e.role <> 'Kiosk'
    )
  )
  from public.employees me
  where me.auth_user_id = (select auth.uid())
    and me.status = 'Active'
  limit 1;
$$;

revoke all on function public.tms_directory_context_v1() from public, anon;
grant execute on function public.tms_directory_context_v1() to authenticated;

-- Republish the dashboard bundle with the directory context attached so the
-- client resolves labels in the same round trip it already makes.
create or replace function public.tms_dashboard_bundle_v1(p_history_days integer default 120)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  today date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  month_start date := date_trunc('month', clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  history_days integer := least(120, greatest(31, coalesce(p_history_days, 120)));
  history_from date;
  request_from date := today - 180;
  request_to date := today + 180;
  bootstrap jsonb;
  history_page_1 jsonb;
  history_page_2 jsonb;
  request_me jsonb;
  request_team jsonb := jsonb_build_object('rows', '[]'::jsonb, 'total', 0, 'page', 1, 'size', 100);
  metadata jsonb;
  directory jsonb;
  capabilities jsonb;
begin
  history_from := today - (history_days - 1);

  bootstrap := public.workforce_query('bootstrap', jsonb_build_object('from', month_start, 'to', today));
  history_page_1 := public.workforce_query('history', jsonb_build_object(
    'from', history_from, 'to', today, 'scope', 'me', 'page', 1, 'size', 100
  ));
  if coalesce((history_page_1 ->> 'total')::integer, 0) > 100 then
    history_page_2 := public.workforce_query('history', jsonb_build_object(
      'from', history_from, 'to', today, 'scope', 'me', 'page', 2, 'size', 20
    ));
  else
    history_page_2 := jsonb_build_object('rows', '[]'::jsonb, 'total', 0, 'page', 2, 'size', 20);
  end if;

  request_me := public.workforce_query('requests', jsonb_build_object(
    'from', request_from, 'to', request_to, 'scope', 'me', 'page', 1, 'size', 100
  ));
  metadata := public.workforce_query('metadata', '{}'::jsonb);
  directory := public.workforce_query('directory', jsonb_build_object(
    'page', 1, 'size', 100, 'status', 'Active'
  ));

  capabilities := coalesce(bootstrap -> 'capabilities', '[]'::jsonb);
  if capabilities ? 'team.read' then
    request_team := public.workforce_query('requests', jsonb_build_object(
      'from', request_from, 'to', request_to, 'scope', 'team',
      'status', 'all', 'page', 1, 'size', 100
    ));
  end if;

  return jsonb_build_object(
    'bootstrap', bootstrap,
    'history', jsonb_build_object(
      'rows', coalesce(history_page_1 -> 'rows', '[]'::jsonb) || coalesce(history_page_2 -> 'rows', '[]'::jsonb),
      'total', coalesce(history_page_1 -> 'total', '0'::jsonb)
    ),
    'requests_me', request_me,
    'requests_team', request_team,
    'metadata', metadata,
    'directory', directory,
    'directory_context', coalesce(public.tms_directory_context_v1(), '{}'::jsonb)
  );
end;
$$;

revoke all on function public.tms_dashboard_bundle_v1(integer) from public, anon;
grant execute on function public.tms_dashboard_bundle_v1(integer) to authenticated;

notify pgrst, 'reload schema';;
