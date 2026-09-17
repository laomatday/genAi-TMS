-- One definition of a day's work credit, computed by the server and stored.
--
-- There were three, and they disagreed:
--
--   Home screen      count(*) where actual_checkin is not null      -> 1 a day
--   History screen   hours >= 8 -> 1, >= 3.5 -> 0.5, leave/holiday -> 1
--   Payroll export   actual_checkin and work_minutes > 0            -> 1 a day
--
-- Someone working twelve five-hour days read 12 on the home screen and 6 in
-- their history, and the spreadsheet that went to payroll said 12 again. The
-- third one is the one that mattered, and it was the least considered.
--
-- The agreed rule, in order — first match wins:
--
--   1  approved leave (annual or sick)          WORKDAY_LEAVE_CREDIT      1
--   2  public holiday                           WORKDAY_HOLIDAY_CREDIT    1
--   3  missing check-out, explanation approved  WORKDAY_EXPLAINED_CREDIT  1
--   4  missing check-out, no explanation        WORKDAY_MISSING_CHECKOUT_CREDIT  0.5
--   5  hours >= MIN_HOURS_FULL                                            1
--   6  hours >= MIN_HOURS_HALF                                            0.5
--   7  anything else                                                      0
--
-- Rule 3 is the owner's decision and is deliberately blind to hours: a manager
-- approving an explanation is confirming the person worked the day, and asking
-- them to also have recorded enough hours would defeat the approval.
--
-- MIN_HOURS_HALF moves from 3.5 to 4 at the same time, also by decision. Six
-- timesheets in the whole system carry a check-in today and none is locked, so
-- the backfill below rewrites history with nothing to disturb — a month from
-- now this would have needed an effective date.
--
-- Stored on the row rather than computed per query, because payroll needs a
-- figure that stays put once a period is closed. It is refreshed with the rest
-- of the day's aggregate and again by the maintenance batch, so a holiday added
-- or an explanation approved settles within one batch interval.

begin;

-- 1. The knobs, all six in config_system where the admin screen can reach them.
insert into public.config_system(organization_id, key, value)
select organization.id, setting.key, setting.value
from public.organizations organization
cross join (values
  ('MIN_HOURS_HALF','4'),
  ('WORKDAY_LEAVE_CREDIT','1'),
  ('WORKDAY_HOLIDAY_CREDIT','1'),
  ('WORKDAY_EXPLAINED_CREDIT','1'),
  ('WORKDAY_MISSING_CHECKOUT_CREDIT','0.5')
) as setting(key, value)
on conflict(organization_id, key) do update set value=excluded.value, updated_at=now();

-- 2. The rule itself. Pure, so it can be reasoned about and tested on its own,
--    and every caller has to pass the thresholds rather than assume them.
create or replace function wf_private.workday_credit(
  p_has_checkin boolean,
  p_has_checkout boolean,
  p_work_minutes integer,
  p_on_approved_leave boolean,
  p_is_holiday boolean,
  p_has_approved_explanation boolean,
  p_full_hours numeric,
  p_half_hours numeric,
  p_leave_credit numeric,
  p_holiday_credit numeric,
  p_explained_credit numeric,
  p_missing_checkout_credit numeric
) returns numeric
language sql
immutable
set search_path to ''
as $function$
  select case
    when p_on_approved_leave then p_leave_credit
    when p_is_holiday then p_holiday_credit
    when coalesce(p_has_checkin,false) and not coalesce(p_has_checkout,false) then
      case when p_has_approved_explanation then p_explained_credit
           else p_missing_checkout_credit end
    when coalesce(p_work_minutes,0)/60.0 >= p_full_hours then 1
    when coalesce(p_work_minutes,0)/60.0 >= p_half_hours then 0.5
    else 0
  end;
$function$;

-- 3. Where the answer lives.
alter table public.timesheets
  add column if not exists work_credit numeric(4,2) not null default 0;

comment on column public.timesheets.work_credit is
  'Ngày công of this day, from wf_private.workday_credit. Written by the server; never by a client.';

-- 4. Recomputing a stored day, in one place, so the refresh and the backfill
--    cannot drift apart.
create or replace function wf_private.recompute_work_credit(
  p_organization_id uuid,
  p_employee_id text,
  p_work_date date
) returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  setting jsonb;
begin
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into setting
  from public.config_system
  where organization_id=p_organization_id
    and key in ('MIN_HOURS_FULL','MIN_HOURS_HALF','WORKDAY_LEAVE_CREDIT',
                'WORKDAY_HOLIDAY_CREDIT','WORKDAY_EXPLAINED_CREDIT',
                'WORKDAY_MISSING_CHECKOUT_CREDIT');

  update public.timesheets sheet
  set work_credit = wf_private.workday_credit(
    sheet.actual_checkin is not null,
    sheet.actual_checkout is not null,
    sheet.work_minutes,
    exists(
      select 1 from public.attendance_requests request
      where request.organization_id=p_organization_id
        and request.employee_id=sheet.employee_id
        and request.status='APPROVED'
        and request.request_type in ('ANNUAL_LEAVE','SICK_LEAVE')
        and sheet.work_date between request.from_date and request.to_date
    ),
    exists(
      select 1 from public.holidays holiday
      where holiday.organization_id=p_organization_id
        and coalesce(holiday.active,true)
        and sheet.work_date between holiday.from_date and holiday.to_date
    ),
    exists(
      select 1 from public.attendance_requests request
      where request.organization_id=p_organization_id
        and request.employee_id=sheet.employee_id
        and request.status='APPROVED'
        and request.request_type in ('EXPLANATION','CORRECTION')
        and sheet.work_date between request.from_date and request.to_date
    ),
    coalesce((setting->>'MIN_HOURS_FULL')::numeric, 8),
    coalesce((setting->>'MIN_HOURS_HALF')::numeric, 4),
    coalesce((setting->>'WORKDAY_LEAVE_CREDIT')::numeric, 1),
    coalesce((setting->>'WORKDAY_HOLIDAY_CREDIT')::numeric, 1),
    coalesce((setting->>'WORKDAY_EXPLAINED_CREDIT')::numeric, 1),
    coalesce((setting->>'WORKDAY_MISSING_CHECKOUT_CREDIT')::numeric, 0.5)
  )
  where sheet.organization_id=p_organization_id
    and sheet.work_date=coalesce(p_work_date, sheet.work_date)
    and (p_employee_id is null or sheet.employee_id=p_employee_id)
    -- A closed period keeps the figure it was closed with.
    and sheet.status<>'LOCKED';
end;
$function$;

-- 5. Backfill. No row is locked, so this rewrites every day there is.
do $backfill$
declare organization record;
begin
  for organization in select id from public.organizations loop
    perform wf_private.recompute_work_credit(organization.id, null, null);
  end loop;
end;
$backfill$;

do $verify$
declare
  wrong bigint;
  total numeric;
begin
  -- Nothing outside the credits the rule can produce.
  select count(*) into wrong from public.timesheets
  where work_credit not in (0, 0.5, 1);
  if wrong > 0 then
    raise exception '% timesheets carry a credit the rule cannot produce', wrong;
  end if;

  -- The two days missing a check-out with no approved explanation must be half.
  select count(*) into wrong from public.timesheets sheet
  where sheet.actual_checkin is not null and sheet.actual_checkout is null
    and sheet.work_credit<>0.5
    and not exists(
      select 1 from public.attendance_requests request
      where request.organization_id=sheet.organization_id
        and request.employee_id=sheet.employee_id
        and request.status='APPROVED'
        and request.request_type in ('EXPLANATION','CORRECTION')
        and sheet.work_date between request.from_date and request.to_date
    );
  if wrong > 0 then
    raise exception '% unexplained missing check-outs were not credited a half day', wrong;
  end if;

  -- A day nobody attended earns nothing.
  select count(*) into wrong from public.timesheets
  where actual_checkin is null and work_credit<>0
    and status='SCHEDULED';
  if wrong > 0 then
    raise exception '% days with no attendance were credited anyway', wrong;
  end if;

  select coalesce(sum(work_credit),0) into total from public.timesheets;
  raise notice 'work_credit backfilled, total across all timesheets: %', total;
end;
$verify$;

commit;

notify pgrst, 'reload schema';
