-- Canonical daily work credit for full-month exports.
-- work_sessions omits paid holidays and approved-leave placeholder days, so
-- export must read timesheets.work_credit directly, not infer days from shifts.
-- Authorization is explicit: a user must have both attendance.export and
-- organization-wide team.read_all capabilities in their own tenant.
begin;

create or replace function public.workforce_export_day_credits(
  p_month text,
  p_cursor_employee_id text default null,
  p_cursor_date date default null
) returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  actor public.employees%rowtype;
  range_start date;
  range_end date;
  page_rows jsonb;
  has_more boolean;
  page_size integer:=1000;
begin
  actor:=wf_private.require_capability('attendance.export');
  perform wf_private.require_capability('team.read_all');

  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Tháng báo cáo không hợp lệ.' using errcode='22023';
  end if;
  if (p_cursor_employee_id is null) <> (p_cursor_date is null) then
    raise exception 'Cursor báo cáo không hợp lệ.' using errcode='22023';
  end if;

  range_start:=(p_month||'-01')::date;
  range_end:=(range_start+interval '1 month - 1 day')::date;
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'employee_id',page.employee_id,
      'work_date',page.work_date,
      'work_credit',page.work_credit,
      'status',page.status
    ) order by page.employee_id,page.work_date
  ),'[]'::jsonb) into page_rows
  from (
    select sheet.employee_id,sheet.work_date,sheet.work_credit,sheet.status
    from public.timesheets sheet
    where sheet.organization_id=actor.organization_id
      and sheet.work_date between range_start and range_end
      and (
        p_cursor_employee_id is null
        or (sheet.employee_id,sheet.work_date)>(p_cursor_employee_id,p_cursor_date)
      )
    order by sheet.employee_id,sheet.work_date
    limit 1001
  ) page;

  has_more:=jsonb_array_length(page_rows)>page_size;
  if has_more then page_rows:=page_rows-(-1); end if;

  return jsonb_build_object(
    'rows',page_rows,
    'has_more',has_more,
    'next_cursor',case
      when not has_more then null
      else jsonb_build_object(
        'employee_id',page_rows->(jsonb_array_length(page_rows)-1)->>'employee_id',
        'work_date',page_rows->(jsonb_array_length(page_rows)-1)->>'work_date'
      )
    end,
    'from',range_start,'to',range_end
  );
end;
$function$;

revoke all on function public.workforce_export_day_credits(text,text,date)
from public,anon,authenticated,service_role;
grant execute on function public.workforce_export_day_credits(text,text,date) to authenticated;

comment on function public.workforce_export_day_credits(text,text,date)
is 'Tenant-scoped, capability-checked, complete day-credit pagination for monthly HR Excel export.';

commit;
notify pgrst, 'reload schema';
