-- Two changes to wf_private.maintain_day_set_based, both patched as fragments so
-- the rest of the function stays exactly as deployed.
--
-- 1. The daily check-in reminder is removed. It fired for every scheduled
--    employee every morning, and the employees it reminds are standing in front
--    of a QR station on their way in.
--
-- 2. The placeholder insert — the one that creates a day's session for a public
--    holiday, approved leave, or a shift about to start — could never run. Its
--    ON CONFLICT names (organization_id, employee_internal_id, business_date,
--    session_sequence), and the only index matching that is
--    work_sessions_day_sequence_key, which is DEFERRABLE INITIALLY DEFERRED.
--    Postgres refuses a deferrable index as an arbiter, so every attempt ended
--    in SQLSTATE 55000. Twenty-six jobs had failed between them 323 times,
--    against eighteen successes that each took one attempt.
--
--    The constraint has to stay deferrable: wf_private.resequence_work_sessions
--    renumbers sessions within a transaction and passes through states an
--    immediate index would reject. So the statement stops asking for an arbiter
--    and skips rows that already exist instead.
--
--    What that gives up: the ON CONFLICT carried a DO UPDATE that refreshed an
--    existing placeholder's expected times and status. Those rows are created
--    within fifteen minutes of a shift starting and are replaced the moment
--    somebody checks in, so the refresh had a narrow window to matter — and it
--    has never once executed, because the statement it belonged to always
--    threw. Nothing that works today is lost.
--
-- Nothing has been lost to the bug so far: it only creates rows for holidays
-- and approved leave, and the tenant has had none of either in this period.

begin;

create or replace function wf_private.patch_day_maintenance(source text, target text)
returns void language plpgsql as $patch$
declare body text; occurrences integer;
begin
  select pg_get_functiondef(p.oid) into body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='wf_private' and p.proname='maintain_day_set_based' and p.prokind='f';
  if body is null then raise exception 'maintain_day_set_based not found'; end if;
  occurrences:=(length(body)-length(replace(body,source,'')))/length(source);
  if occurrences<>1 then
    raise exception 'expected exactly one occurrence to patch, found %', occurrences;
  end if;
  execute replace(body,source,target);
end;
$patch$;

-- 1. Drop the check-in reminder.
select wf_private.patch_day_maintenance(
$old$  insert into public.workforce_notifications(
    organization_id,employee_id,dedupe_key,kind,title,body,context
  )
  select session.organization_id,session.employee_id,
    left('checkin:'||session.id::text,200),'CHECKIN_REMINDER',
    'Sắp đến giờ làm việc','Kiểm tra lịch và chấm công khi đến nơi.',
    jsonb_build_object('date',session.business_date,'work_session_id',session.id)
  from public.work_sessions session
  where session.organization_id=p_organization_id
    and session.business_date=p_work_date and session.status='SCHEDULED'
    and session.actual_checkin is null
    and p_now between session.expected_start-interval '15 minutes'
                  and session.expected_start+interval '4 hours'
  on conflict(employee_id,dedupe_key) do nothing;
$old$,
$new$  -- The daily check-in reminder used to be raised here.
$new$);

-- 2. Stop the placeholder insert asking for a deferrable arbiter.
select wf_private.patch_day_maintenance(
$old$  where prepared.holiday_id is not null
     or prepared.leave_request_id is not null
     or p_now>=prepared.expected_start-interval '15 minutes'
  on conflict(organization_id,employee_internal_id,business_date,session_sequence)
  do update set
    policy_id=excluded.policy_id,
    location_internal_id=excluded.location_internal_id,
    location_id=excluded.location_id,
    expected_start=excluded.expected_start,
    expected_end=excluded.expected_end,
    status=excluded.status,
    exception_codes=excluded.exception_codes,
    paid_leave_minutes=excluded.paid_leave_minutes
  where public.work_sessions.assignment_id is null
    and public.work_sessions.actual_checkin is null
    and public.work_sessions.status not in ('LOCKED','PENDING_REVIEW','REJECTED')$old$,
$new$  where (
      prepared.holiday_id is not null
      or prepared.leave_request_id is not null
      or p_now>=prepared.expected_start-interval '15 minutes'
    )
    and not exists (
      select 1 from public.work_sessions existing
      where existing.organization_id=prepared.organization_id
        and existing.employee_internal_id=prepared.employee_internal_id
        and existing.business_date=p_work_date
        and existing.session_sequence=1
    )$new$);

drop function wf_private.patch_day_maintenance(text, text);

do $verify$
declare body text;
begin
  select pg_get_functiondef(p.oid) into body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='wf_private' and p.proname='maintain_day_set_based' and p.prokind='f';
  if body like '%CHECKIN_REMINDER%' then
    raise exception 'the check-in reminder survived the patch';
  end if;
  if body like '%on conflict(organization_id,employee_internal_id,business_date,session_sequence)%' then
    raise exception 'the deferrable arbiter survived the patch';
  end if;
  -- The parts that do work must still be there.
  if body not like '%CHECKOUT_REMINDER%'
    or body not like '%on conflict(organization_id,assignment_id) where assignment_id is not null%' then
    raise exception 'the patch removed more than it was meant to';
  end if;
end;
$verify$;

commit;
