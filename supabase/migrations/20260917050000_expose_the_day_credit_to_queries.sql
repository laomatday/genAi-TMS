-- Hands the stored day credit to the two screens still doing their own sums.
--
-- Both read work_sessions, which is one row per session, not per day. The
-- payroll export adds one work-day per row it sees, so a split shift — morning
-- out, afternoon back in, which the system records correctly and encourages —
-- was worth two ngày công in the spreadsheet that goes to payroll. There are
-- 147 sessions across 145 employee-days in production right now, so two days
-- are already counted twice.
--
-- Each session row now carries its day's credit, the same stored figure the
-- home screen reads. It is the day's value repeated on every session of that
-- day, so a caller must take it once per date and never add it up per row —
-- which is the mistake being fixed, named here so it is not made again.

begin;

create or replace function wf_private.patch_function(p_name text, source text, target text)
returns void language plpgsql as $patch$
declare body text; occurrences integer;
begin
  select pg_get_functiondef(p.oid) into body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='wf_private' and p.proname=p_name and p.prokind='f';
  if body is null then raise exception '% not found', p_name; end if;
  occurrences:=(length(body)-length(replace(body,source,'')))/greatest(length(source),1);
  if occurrences<>1 then
    raise exception 'expected exactly one occurrence in %, found %', p_name, occurrences;
  end if;
  execute replace(body,source,target);
end;
$patch$;

-- The employee's own history.
select wf_private.patch_function('query_commercial',
$old$      select session.*,employee.name as employee_name,location.center_name as location_name
      from public.work_sessions session
      join public.employees employee
        on employee.organization_id=session.organization_id
       and employee.internal_id=session.employee_internal_id
      left join public.locations location
        on location.organization_id=session.organization_id
       and location.internal_id=session.location_internal_id$old$,
$new$      select session.*,employee.name as employee_name,location.center_name as location_name,
        coalesce(sheet.work_credit,0) as day_work_credit
      from public.work_sessions session
      join public.employees employee
        on employee.organization_id=session.organization_id
       and employee.internal_id=session.employee_internal_id
      left join public.locations location
        on location.organization_id=session.organization_id
       and location.internal_id=session.location_internal_id
      left join public.timesheets sheet
        on sheet.organization_id=session.organization_id
       and sheet.employee_id=session.employee_id
       and sheet.work_date=session.business_date$new$);

-- The admin attendance table, which is what the payroll export reads.
select wf_private.patch_function('query_commercial',
$old$        select session.*,employee.name as employee_name
        from public.work_sessions session
        join public.employees employee
          on employee.organization_id=session.organization_id
         and employee.internal_id=session.employee_internal_id$old$,
$new$        select session.*,employee.name as employee_name,
          coalesce(sheet.work_credit,0) as day_work_credit
        from public.work_sessions session
        join public.employees employee
          on employee.organization_id=session.organization_id
         and employee.internal_id=session.employee_internal_id
        left join public.timesheets sheet
          on sheet.organization_id=session.organization_id
         and sheet.employee_id=session.employee_id
         and sheet.work_date=session.business_date$new$);

drop function wf_private.patch_function(text, text, text);

do $verify$
declare body text; occurrences integer;
begin
  select pg_get_functiondef(p.oid) into body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='wf_private' and p.proname='query_commercial';
  occurrences:=(length(body)-length(replace(body,'day_work_credit','')))/length('day_work_credit');
  if occurrences<>2 then
    raise exception 'expected the day credit on both session resources, found %', occurrences;
  end if;
  -- The joins that were already there must survive.
  if body not like '%location.center_name as location_name%'
    or body not like '%employee.name as employee_name%' then
    raise exception 'the patch removed columns it was not meant to touch';
  end if;
end;
$verify$;

commit;

notify pgrst, 'reload schema';
