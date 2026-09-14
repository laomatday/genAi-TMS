-- Payroll close owns an exclusive advisory lock for every covered month. Core
-- attendance/request writers must take the matching shared lock before checking
-- CLOSED, otherwise a concurrent close can pass its checklist and commit while
-- a writer that already observed the old state creates data in the closed period.
set local lock_timeout='5s';
set local statement_timeout='120s';

create function wf_private.patch_period_sensitive_fragment(
  p_signature regprocedure,
  p_old text,
  p_new text
)
returns void
language plpgsql
set search_path=''
as $$
declare
  definition text;
  occurrences integer;
begin
  if p_old is null or p_old='' then
    raise exception 'Empty period-sensitive function patch';
  end if;
  select pg_catalog.pg_get_functiondef(p_signature) into definition;
  occurrences := (length(definition)-length(replace(definition,p_old,'')))/length(p_old);
  if occurrences<>1 then
    raise exception 'Expected one occurrence in %, found %',p_signature,occurrences;
  end if;
  execute replace(definition,p_old,p_new);
end;
$$;

revoke all on function wf_private.patch_period_sensitive_fragment(
  regprocedure,text,text
) from public,anon,authenticated,service_role;

-- Attendance already serializes one employee and replays an existing receipt
-- first. For checkout/pause/resume, discover the active work date without a
-- row lock, join the period protocol, then lock and revalidate that same row.
-- This keeps the global order period -> timesheet used by payroll close and
-- maintenance, avoiding a timesheet -> period deadlock on stale sessions.
select wf_private.patch_period_sensitive_fragment(
  'wf_private.attendance(jsonb)'::regprocedure,
  $old$else
  select * into sheet from public.timesheets where organization_id=a.organization_id and employee_id=a.employee_id and actual_checkin is not null and actual_checkout is null and status not in ('LOCKED','CANCELLED') and not ('SUPERSEDED_BY_NEW_CHECKIN'=any(coalesce(exception_codes,'{}'))) order by actual_checkin desc limit 1 for update;
  if not found then return wf_private.failure('NO_ACTIVE_SESSION','Không có ca đang mở.'); end if;
  day:=sheet.work_date; site:=sheet.location_id;
 end if;$old$,
  $new$else
  select * into sheet from public.timesheets where organization_id=a.organization_id and employee_id=a.employee_id and actual_checkin is not null and actual_checkout is null and status not in ('LOCKED','CANCELLED') and not ('SUPERSEDED_BY_NEW_CHECKIN'=any(coalesce(exception_codes,'{}'))) order by actual_checkin desc limit 1;
  if not found then return wf_private.failure('NO_ACTIVE_SESSION','Không có ca đang mở.'); end if;
  day:=sheet.work_date; site:=sheet.location_id;
  perform wf_private.period_lock(a.organization_id,day,day,false);
  if exists(select 1 from public.attendance_periods as closed_period where closed_period.organization_id=a.organization_id and closed_period.status='CLOSED' and day between closed_period.period_start and closed_period.period_end) then
   return wf_private.failure('PERIOD_LOCKED','Kỳ công đã khóa. Liên hệ HR để xử lý có kiểm soát.'); end if;
  select * into sheet from public.timesheets where id=sheet.id and organization_id=a.organization_id and employee_id=a.employee_id and actual_checkin is not null and actual_checkout is null and status not in ('LOCKED','CANCELLED') and not ('SUPERSEDED_BY_NEW_CHECKIN'=any(coalesce(exception_codes,'{}'))) for update;
  if not found then return wf_private.failure('NO_ACTIVE_SESSION','Không có ca đang mở.'); end if;
  day:=sheet.work_date; site:=sheet.location_id;
 end if;$new$
);

-- Check-in targets the current local day, which payroll does not normally
-- close. The common lock below still protects this mutation before CLOSED is
-- observed and before any check-in write occurs.
select wf_private.patch_period_sensitive_fragment(
  'wf_private.attendance(jsonb)'::regprocedure,
  $old$if exists(select 1 from public.attendance_periods ap where ap.organization_id=a.organization_id and ap.status='CLOSED' and day between ap.period_start and ap.period_end) then$old$,
  $new$perform wf_private.period_lock(a.organization_id,day,day,false);
 if exists(select 1 from public.attendance_periods ap where ap.organization_id=a.organization_id and ap.status='CLOSED' and day between ap.period_start and ap.period_end) then$new$
);

-- The idempotency migration positions replay before this CLOSED check. A replay
-- remains readable after a later payroll close; only a genuinely new request
-- joins the shared/exclusive period-lock protocol.
select wf_private.patch_period_sensitive_fragment(
  'wf_private.submit_request(jsonb)'::regprocedure,
  $old$if exists(select 1 from public.attendance_periods where organization_id=a.organization_id and status='CLOSED' and daterange(period_start,period_end,'[]') && daterange(first_day,last_day,'[]')) then$old$,
  $new$perform wf_private.period_lock(a.organization_id,first_day,last_day,false);
 if exists(select 1 from public.attendance_periods where organization_id=a.organization_id and status='CLOSED' and daterange(period_start,period_end,'[]') && daterange(first_day,last_day,'[]')) then$new$
);

-- Review may update a timesheet, leave balance or published assignment. Hold the
-- same shared period lock before re-checking the closed-period boundary.
select wf_private.patch_period_sensitive_fragment(
  'wf_private.review_request(jsonb)'::regprocedure,
  $old$if exists(select 1 from public.attendance_periods where organization_id=a.organization_id and status='CLOSED' and daterange(period_start,period_end,'[]')&&daterange(r.from_date,r.to_date,'[]')) then$old$,
  $new$perform wf_private.period_lock(a.organization_id,r.from_date,r.to_date,false);
 if exists(select 1 from public.attendance_periods where organization_id=a.organization_id and status='CLOSED' and daterange(period_start,period_end,'[]')&&daterange(r.from_date,r.to_date,'[]')) then$new$
);

drop function wf_private.patch_period_sensitive_fragment(regprocedure,text,text);

do $verify$
declare
  attendance_definition text:=pg_catalog.pg_get_functiondef(
    'wf_private.attendance(jsonb)'::regprocedure
  );
  submit_definition text:=pg_catalog.pg_get_functiondef(
    'wf_private.submit_request(jsonb)'::regprocedure
  );
  review_definition text:=pg_catalog.pg_get_functiondef(
    'wf_private.review_request(jsonb)'::regprocedure
  );
  attendance_lock integer;
  attendance_closed integer;
  attendance_active_lookup integer;
  attendance_active_closed integer;
  attendance_active_row_lock integer;
  submit_replay integer;
  submit_lock integer;
  submit_closed integer;
  review_lock integer;
  review_closed integer;
begin
  attendance_lock:=position(
    'period_lock(a.organization_id,day,day,false)' in attendance_definition
  );
  attendance_closed:=position(
    'day between ap.period_start and ap.period_end' in attendance_definition
  );
  attendance_active_lookup:=position(
    'order by actual_checkin desc limit 1;' in attendance_definition
  );
  attendance_active_closed:=position(
    'day between closed_period.period_start and closed_period.period_end'
    in attendance_definition
  );
  attendance_active_row_lock:=position(
    'select * into sheet from public.timesheets where id=sheet.id'
    in attendance_definition
  );
  submit_replay:=position(
    '''replayed'',true' in submit_definition
  );
  submit_lock:=position(
    'period_lock(a.organization_id,first_day,last_day,false)' in submit_definition
  );
  submit_closed:=position(
    'daterange(period_start,period_end,''[]'') && daterange(first_day,last_day,''[]'')' in submit_definition
  );
  review_lock:=position(
    'period_lock(a.organization_id,r.from_date,r.to_date,false)' in review_definition
  );
  review_closed:=position(
    'daterange(period_start,period_end,''[]'')&&daterange(r.from_date,r.to_date,''[]'')' in review_definition
  );

  if attendance_lock=0 or attendance_closed=0 or attendance_lock>=attendance_closed then
    raise exception 'Attendance period lock must precede the CLOSED check';
  end if;
  if attendance_active_lookup=0 or attendance_active_closed=0
    or attendance_active_row_lock=0
    or attendance_active_lookup>=attendance_lock
    or attendance_lock>=attendance_active_closed
    or attendance_active_closed>=attendance_active_row_lock then
    raise exception 'Active attendance lock order must be lookup/period/CLOSED/timesheet';
  end if;
  if submit_replay=0 or submit_lock=0 or submit_closed=0
    or submit_replay>=submit_lock or submit_lock>=submit_closed then
    raise exception 'Request replay/period-lock/CLOSED ordering is invalid';
  end if;
  if review_lock=0 or review_closed=0 or review_lock>=review_closed then
    raise exception 'Request review period lock must precede the CLOSED check';
  end if;
end;
$verify$;

notify pgrst,'reload schema';
