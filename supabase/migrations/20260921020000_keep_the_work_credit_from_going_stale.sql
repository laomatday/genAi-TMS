-- Makes the stored credit impossible to leave stale.
--
-- It was computed by whoever remembered to call recompute_work_credit, and the
-- maintenance batch does not: maintain_day_set_based writes timesheets directly
-- every fifteen minutes, so any day it touched kept whatever credit was there
-- before. Seven people on 18/09 sat at 0 when the rule says 0.5 — a missing
-- check-out with no explanation — because the batch had rewritten their row
-- after the credit was last worked out.
--
-- That is the failure mode of a derived value maintained by convention: it is
-- right until somebody adds a writer, and then it is quietly wrong in a number
-- people are paid from.
--
-- So it is a trigger now. Every insert and update of a timesheet recomputes the
-- credit from the row being written, whichever path the write came down. There
-- is no longer a way to write a timesheet and forget.
--
-- LOCKED rows keep the figure they were closed with, as before.

begin;

create or replace function wf_private.set_work_credit()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  setting jsonb;
begin
  -- A closed period is not recalculated, whatever else changes.
  if new.status='LOCKED' then
    return new;
  end if;

  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into setting
  from public.config_system
  where organization_id=new.organization_id
    and key in ('MIN_HOURS_FULL','MIN_HOURS_HALF','WORKDAY_LEAVE_CREDIT',
                'WORKDAY_HOLIDAY_CREDIT','WORKDAY_EXPLAINED_CREDIT',
                'WORKDAY_MISSING_CHECKOUT_CREDIT');

  new.work_credit:=wf_private.workday_credit(
    new.actual_checkin is not null,
    new.actual_checkout is not null,
    new.work_minutes,
    exists(
      select 1 from public.attendance_requests request
      where request.organization_id=new.organization_id
        and request.employee_id=new.employee_id
        and request.status='APPROVED'
        and request.request_type in ('ANNUAL_LEAVE','SICK_LEAVE')
        and new.work_date between request.from_date and request.to_date
    ),
    exists(
      select 1 from public.holidays holiday
      where holiday.organization_id=new.organization_id
        and coalesce(holiday.active,true)
        and new.work_date between holiday.from_date and holiday.to_date
    ),
    exists(
      select 1 from public.attendance_requests request
      where request.organization_id=new.organization_id
        and request.employee_id=new.employee_id
        and request.status='APPROVED'
        and request.request_type in ('EXPLANATION','CORRECTION')
        and new.work_date between request.from_date and request.to_date
    ),
    coalesce((setting->>'MIN_HOURS_FULL')::numeric, 8),
    coalesce((setting->>'MIN_HOURS_HALF')::numeric, 4),
    coalesce((setting->>'WORKDAY_LEAVE_CREDIT')::numeric, 1),
    coalesce((setting->>'WORKDAY_HOLIDAY_CREDIT')::numeric, 1),
    coalesce((setting->>'WORKDAY_EXPLAINED_CREDIT')::numeric, 1),
    coalesce((setting->>'WORKDAY_MISSING_CHECKOUT_CREDIT')::numeric, 0.5)
  );
  return new;
end;
$function$;

drop trigger if exists timesheets_set_work_credit on public.timesheets;
create trigger timesheets_set_work_credit
before insert or update on public.timesheets
for each row execute function wf_private.set_work_credit();

-- Repair what went stale. recompute_work_credit stays for the cases no
-- timesheet write accompanies — a holiday added months later, say.
do $repair$
declare organization record;
begin
  for organization in select id from public.organizations loop
    perform wf_private.recompute_work_credit(organization.id, null, null);
  end loop;
end;
$repair$;

do $verify$
declare wrong bigint;
begin
  -- The case that went stale: a check-in, no check-out, no approved
  -- explanation. The rule says half a day.
  select count(*) into wrong from public.timesheets sheet
  where sheet.actual_checkin is not null and sheet.actual_checkout is null
    and sheet.status<>'LOCKED'
    and sheet.work_credit<>0.5
    and not exists(
      select 1 from public.attendance_requests request
      where request.organization_id=sheet.organization_id
        and request.employee_id=sheet.employee_id
        and request.status='APPROVED'
        and request.request_type in ('EXPLANATION','CORRECTION')
        and sheet.work_date between request.from_date and request.to_date
    );
  if wrong>0 then
    raise exception '% unexplained missing check-outs are still not half a day', wrong;
  end if;

  -- And the trigger has to actually be attached.
  if not exists(
    select 1 from pg_trigger
    where tgrelid='public.timesheets'::regclass
      and tgname='timesheets_set_work_credit' and not tgisinternal
  ) then
    raise exception 'the work-credit trigger is not attached';
  end if;
end;
$verify$;

commit;

notify pgrst, 'reload schema';
