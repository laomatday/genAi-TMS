-- Attendance lifecycle correction:
-- 1. A stale unfinished session from an earlier work date must not block today's check-in.
-- 2. Starting a new session explicitly supersedes older unfinished sessions without
--    inventing a checkout event or deleting raw evidence.
-- 3. Reason-only explanations never manufacture paid hours; time corrections require
--    explicit proposed check-in/check-out timestamps and an approval audit event.
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create or replace function wf_private.patch_attendance_lifecycle_fragment(
  p_signature regprocedure,
  p_old text,
  p_new text
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  definition text;
  occurrences integer;
begin
  if p_old is null or p_old = '' then
    raise exception 'Empty attendance lifecycle patch fragment';
  end if;
  select pg_catalog.pg_get_functiondef(p_signature) into definition;
  occurrences := (
    length(definition) - length(replace(definition, p_old, ''))
  ) / length(p_old);
  if occurrences <> 1 then
    raise exception 'Expected one occurrence in %, found %', p_signature, occurrences;
  end if;
  execute replace(definition, p_old, p_new);
end;
$$;
revoke all on function wf_private.patch_attendance_lifecycle_fragment(regprocedure, text, text)
  from public, anon, authenticated;

insert into wf_private.upgrade_snapshots(release, source_table, source_id, reason, row_data)
values (
  'attendance-session-rollover', 'function', 'wf_private.attendance(jsonb)',
  'Permit a new-day check-in while preserving an unfinished earlier session',
  jsonb_build_object('definition', pg_catalog.pg_get_functiondef('wf_private.attendance(jsonb)'::regprocedure))
)
on conflict do nothing;

select wf_private.patch_attendance_lifecycle_fragment(
  'wf_private.attendance(jsonb)'::regprocedure,
  $old$event uuid; event_kind text; receipt uuid:=extensions.gen_random_uuid(); result jsonb; site text;$old$,
  $new$event uuid; event_kind text; receipt uuid:=extensions.gen_random_uuid(); result jsonb; site text; stale_count integer:=0;$new$
);

select wf_private.patch_attendance_lifecycle_fragment(
  'wf_private.attendance(jsonb)'::regprocedure,
  $old$if act='checkin' then
  if exists(select 1 from public.timesheets where employee_id=a.employee_id and actual_checkin is not null and actual_checkout is null and status not in ('LOCKED','CANCELLED')) then
   return wf_private.failure('ALREADY_OPEN','Bạn còn ca chưa check-out. Hoàn tất ca đó trước.'); end if;$old$,
  $new$if act='checkin' then
  if exists(select 1 from public.timesheets where organization_id=a.organization_id and employee_id=a.employee_id and work_date=day and actual_checkin is not null and actual_checkout is null and status not in ('LOCKED','CANCELLED')) then
   return wf_private.failure('ALREADY_OPEN','Bạn đã có ca đang mở trong ngày hôm nay.'); end if;$new$
);

select wf_private.patch_attendance_lifecycle_fragment(
  'wf_private.attendance(jsonb)'::regprocedure,
  $old$select * into sheet from public.timesheets where employee_id=a.employee_id and actual_checkin is not null and actual_checkout is null and status not in ('LOCKED','CANCELLED') order by actual_checkin desc limit 1 for update;$old$,
  $new$select * into sheet from public.timesheets where organization_id=a.organization_id and employee_id=a.employee_id and actual_checkin is not null and actual_checkout is null and status not in ('LOCKED','CANCELLED') and not ('SUPERSEDED_BY_NEW_CHECKIN'=any(coalesce(exception_codes,'{}'))) order by actual_checkin desc limit 1 for update;$new$
);

select wf_private.patch_attendance_lifecycle_fragment(
  'wf_private.attendance(jsonb)'::regprocedure,
  $old$if act='checkin' then
  expected_start_at:=((day+pol.expected_start) at time zone 'Asia/Ho_Chi_Minh');$old$,
  $new$if act='checkin' then
  update public.timesheets
  set status=case when status='PENDING_REVIEW' then status else 'EXCEPTION' end,
      exception_codes=array_append(
        array_remove(
          array_append(array_remove(coalesce(exception_codes,'{}'),'MISSING_CHECKOUT'),'MISSING_CHECKOUT'),
          'SUPERSEDED_BY_NEW_CHECKIN'
        ),
        'SUPERSEDED_BY_NEW_CHECKIN'
      ),
      break_minutes=break_minutes+case when break_started_at is null then 0 else greatest(0,floor(extract(epoch from(now_at-break_started_at))/60)::integer) end,
      break_started_at=null
  where organization_id=a.organization_id
    and employee_id=a.employee_id
    and work_date<day
    and actual_checkin is not null
    and actual_checkout is null
    and status not in ('LOCKED','CANCELLED')
    and not ('SUPERSEDED_BY_NEW_CHECKIN'=any(coalesce(exception_codes,'{}')));
  get diagnostics stale_count = row_count;
  if stale_count>0 then
   perform wf_private.audit('STALE_ATTENDANCE_SUPERSEDED','employee',a.employee_id,'Mở ca mới khi còn ca cũ thiếu check-out',jsonb_build_object('new_work_date',day,'superseded_count',stale_count));
  end if;
  expected_start_at:=((day+pol.expected_start) at time zone 'Asia/Ho_Chi_Minh');$new$
);

insert into wf_private.upgrade_snapshots(release, source_table, source_id, reason, row_data)
values (
  'attendance-session-rollover', 'function', 'wf_private.submit_request(jsonb)',
  'Allow explanations for missing timesheets and validate correction timestamps before review',
  jsonb_build_object('definition', pg_catalog.pg_get_functiondef('wf_private.submit_request(jsonb)'::regprocedure))
)
on conflict do nothing;

select wf_private.patch_attendance_lifecycle_fragment(
  'wf_private.submit_request(jsonb)'::regprocedure,
  $old$declare a public.employees%rowtype; r public.attendance_requests%rowtype; t public.timesheets%rowtype;
 owner_id text; backup_id text; first_day date:=(p->>'from_date')::date; last_day date:=coalesce((p->>'to_date')::date,(p->>'from_date')::date);$old$,
  $new$declare a public.employees%rowtype; r public.attendance_requests%rowtype; t public.timesheets%rowtype;
 pol public.attendance_policies%rowtype; correction_shift public.config_shifts%rowtype;
 owner_id text; backup_id text; requested_start_at timestamptz; requested_end_at timestamptz;
 first_day date:=(p->>'from_date')::date; last_day date:=coalesce((p->>'to_date')::date,(p->>'from_date')::date);$new$
);

select wf_private.patch_attendance_lifecycle_fragment(
  'wf_private.submit_request(jsonb)'::regprocedure,
  $old$if kind in ('EXPLANATION','CORRECTION') then
  if first_day<>last_day or first_day>(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date then raise exception 'Chỉ điều chỉnh một ngày đã xảy ra.'; end if;
  select * into t from public.timesheets where employee_id=a.employee_id and work_date=first_day for update;
  if not found then raise exception 'Chưa có bảng công cho ngày này. Quản lý cần đối soát trước.'; end if;
  if t.status='LOCKED' then raise exception 'Ngày công đã khóa.'; end if;
  if kind='CORRECTION' and p->>'requested_checkin' is null and p->>'requested_checkout' is null then raise exception 'Điều chỉnh cần có giờ đề nghị.'; end if;
  detail:=jsonb_build_object('previous_status',t.status);
 end if;$old$,
  $new$if kind in ('EXPLANATION','CORRECTION') then
  if first_day<>last_day or first_day>(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date then raise exception 'Chỉ điều chỉnh một ngày đã xảy ra.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('workforce:'||a.employee_id,0));
  select * into t from public.timesheets where organization_id=a.organization_id and employee_id=a.employee_id and work_date=first_day for update;
  if not found then
   select * into pol from public.attendance_policies where id=a.attendance_policy_id and organization_id=a.organization_id and active;
   if not found then raise exception 'Chưa có chính sách chấm công cho ngày cần xử lý.'; end if;
   select * into sa from public.shift_assignments where organization_id=a.organization_id and employee_id=a.employee_id and work_date=first_day and publication_status='PUBLISHED';
   if sa.id is not null then
    select * into correction_shift from public.config_shifts where id=sa.shift_id and organization_id=a.organization_id and active;
   end if;
   insert into public.timesheets(employee_id,work_date,policy_id,location_id,expected_start,expected_end,status,source,exception_codes)
   values(
    a.employee_id,first_day,pol.id,coalesce(sa.location_id,a.center_id),
    case when correction_shift.id is not null then (first_day+correction_shift.start_time) at time zone 'Asia/Ho_Chi_Minh' else (first_day+pol.expected_start) at time zone 'Asia/Ho_Chi_Minh' end,
    case when correction_shift.id is not null then (first_day+correction_shift.end_time+case when correction_shift.end_time<=correction_shift.start_time then interval '1 day' else interval '0 days' end) at time zone 'Asia/Ho_Chi_Minh' else (first_day+pol.expected_end+case when pol.expected_end<=pol.expected_start then interval '1 day' else interval '0 days' end) at time zone 'Asia/Ho_Chi_Minh' end,
    'EXCEPTION','NORMAL',array['MISSING_CHECKIN','MISSING_CHECKOUT']
   )
   on conflict(employee_id,work_date) do nothing
   returning * into t;
   if not found then select * into t from public.timesheets where organization_id=a.organization_id and employee_id=a.employee_id and work_date=first_day for update; end if;
  end if;
  if t.id is null then raise exception 'Không thể tạo bảng công cho ngày cần xử lý.'; end if;
  if t.status='LOCKED' then raise exception 'Ngày công đã khóa.'; end if;
  if kind='CORRECTION' then
   requested_start_at:=coalesce((p->>'requested_checkin')::timestamptz,t.actual_checkin);
   requested_end_at:=coalesce((p->>'requested_checkout')::timestamptz,t.actual_checkout);
   if requested_start_at is null or requested_end_at is null or requested_end_at<=requested_start_at or requested_end_at-requested_start_at>interval '24 hours'
    or (requested_start_at at time zone 'Asia/Ho_Chi_Minh')::date<>first_day or requested_end_at>clock_timestamp() then
    raise exception 'Điều chỉnh cần đủ giờ thực tế hợp lệ, tối đa 24 giờ và không nằm trong tương lai.';
   end if;
  end if;
  detail:=jsonb_build_object('previous_status',t.status);
 end if;$new$
);

insert into wf_private.upgrade_snapshots(release, source_table, source_id, reason, row_data)
values (
  'attendance-session-rollover', 'function', 'wf_private.review_request(jsonb)',
  'Separate reason approval from audited attendance time correction',
  jsonb_build_object('definition', pg_catalog.pg_get_functiondef('wf_private.review_request(jsonb)'::regprocedure))
)
on conflict do nothing;

select wf_private.patch_attendance_lifecycle_fragment(
  'wf_private.review_request(jsonb)'::regprocedure,
  $old$decision text:=p->>'decision'; why text:=trim(coalesce(p->>'note','')); days integer:=0; start_at timestamptz; end_at timestamptz; unpaid integer:=0;$old$,
  $new$decision text:=p->>'decision'; why text:=trim(coalesce(p->>'note','')); days integer:=0; start_at timestamptz; end_at timestamptz; unpaid integer:=0; late_m integer:=0; early_m integer:=0; codes text[]:='{}';$new$
);

select wf_private.patch_attendance_lifecycle_fragment(
  'wf_private.review_request(jsonb)'::regprocedure,
  $old$elsif r.request_type in ('EXPLANATION','CORRECTION') then
   select * into t from public.timesheets where id=r.timesheet_id for update;
   if t.status='LOCKED' then raise exception 'Ngày công đã khóa.'; end if;
   start_at:=coalesce(r.requested_checkin,t.actual_checkin); end_at:=coalesce(r.requested_checkout,t.actual_checkout);
   if start_at is null or end_at is null or end_at<=start_at or end_at-start_at>interval '24 hours' or (start_at at time zone 'Asia/Ho_Chi_Minh')::date<>t.work_date or end_at>clock_timestamp() then raise exception 'Thiếu giờ thực tế hợp lệ. Cần yêu cầu điều chỉnh, không tự quy đủ công từ giải trình.'; end if;
   unpaid:=greatest(t.break_minutes,case when end_at-start_at>=interval '6 hours' then coalesce(pol.unpaid_break_minutes,0) else 0 end);
   perform wf_private.audit('TIMESHEET_BEFORE_CORRECTION','timesheet',t.id::text,why,to_jsonb(t));
   update public.timesheets set actual_checkin=start_at,actual_checkout=end_at,source=case when r.request_type='CORRECTION' then 'ADJUSTED' else source end,
    work_minutes=greatest(0,floor(extract(epoch from(end_at-start_at))/60)::integer-unpaid),status='APPROVED'
   where id=t.id;
   if r.request_type='CORRECTION' then insert into public.attendance_events(timesheet_id,employee_id,event_type,work_date,location_id,outcome,validation)
    values(t.id,e.employee_id,'CORRECTION',t.work_date,t.location_id,'VALID',jsonb_build_object('request_id',r.id,'approver',a.employee_id,'requested_checkin',start_at,'requested_checkout',end_at)); end if;$old$,
  $new$elsif r.request_type='EXPLANATION' then
   select * into t from public.timesheets where id=r.timesheet_id and organization_id=a.organization_id and employee_id=r.employee_id for update;
   if not found then raise exception 'Không tìm thấy bảng công cần giải trình.'; end if;
   if t.status='LOCKED' then raise exception 'Ngày công đã khóa.'; end if;
   perform wf_private.audit('TIMESHEET_EXPLANATION_APPROVED','timesheet',t.id::text,why,jsonb_build_object('request_id',r.id,'before',to_jsonb(t)));
   update public.timesheets
   set status=case when actual_checkin is null or actual_checkout is null then 'EXCEPTION' else 'APPROVED' end
   where id=t.id;
  elsif r.request_type='CORRECTION' then
   select * into t from public.timesheets where id=r.timesheet_id and organization_id=a.organization_id and employee_id=r.employee_id for update;
   if not found then raise exception 'Không tìm thấy bảng công cần điều chỉnh.'; end if;
   if t.status='LOCKED' then raise exception 'Ngày công đã khóa.'; end if;
   start_at:=coalesce(r.requested_checkin,t.actual_checkin); end_at:=coalesce(r.requested_checkout,t.actual_checkout);
   if start_at is null or end_at is null or end_at<=start_at or end_at-start_at>interval '24 hours' or (start_at at time zone 'Asia/Ho_Chi_Minh')::date<>t.work_date or end_at>clock_timestamp() then raise exception 'Thiếu giờ thực tế hợp lệ. Cần yêu cầu điều chỉnh với giờ check-in và check-out chính xác.'; end if;
   unpaid:=greatest(t.break_minutes,case when end_at-start_at>=interval '6 hours' then coalesce(pol.unpaid_break_minutes,0) else 0 end);
   codes:=coalesce(t.exception_codes,'{}');
   codes:=array_remove(codes,'MISSING_CHECKIN');
   codes:=array_remove(codes,'MISSING_CHECKOUT');
   codes:=array_remove(codes,'SUPERSEDED_BY_NEW_CHECKIN');
   codes:=array_remove(codes,'LATE');
   codes:=array_remove(codes,'EARLY_LEAVE');
   if t.expected_start is not null and start_at>t.expected_start+make_interval(mins=>pol.late_tolerance_minutes) then
    late_m:=greatest(0,floor(extract(epoch from(start_at-t.expected_start))/60)::integer);
    codes:=array_append(codes,'LATE');
   end if;
   if t.expected_end is not null and end_at<t.expected_end-make_interval(mins=>pol.early_tolerance_minutes) then
    early_m:=greatest(0,floor(extract(epoch from(t.expected_end-end_at))/60)::integer);
    codes:=array_append(codes,'EARLY_LEAVE');
   end if;
   perform wf_private.audit('TIMESHEET_BEFORE_CORRECTION','timesheet',t.id::text,why,to_jsonb(t));
   update public.timesheets
   set actual_checkin=start_at,actual_checkout=end_at,source='ADJUSTED',
       work_minutes=greatest(0,floor(extract(epoch from(end_at-start_at))/60)::integer-unpaid),
       break_started_at=null,break_minutes=unpaid,late_minutes=late_m,early_minutes=early_m,
       exception_codes=codes,status='APPROVED'
   where id=t.id;
   insert into public.attendance_events(timesheet_id,employee_id,event_type,work_date,location_id,outcome,validation)
   values(t.id,e.employee_id,'CORRECTION',t.work_date,t.location_id,'VALID',jsonb_build_object('request_id',r.id,'approver',a.employee_id,'requested_checkin',start_at,'requested_checkout',end_at));$new$
);

create index if not exists timesheets_employee_unfinished_idx
  on public.timesheets (organization_id, employee_id, actual_checkin desc)
  where actual_checkin is not null and actual_checkout is null and status not in ('LOCKED','CANCELLED');

drop function wf_private.patch_attendance_lifecycle_fragment(regprocedure, text, text);

do $verify$
declare
  attendance_definition text := pg_catalog.pg_get_functiondef('wf_private.attendance(jsonb)'::regprocedure);
  submit_definition text := pg_catalog.pg_get_functiondef('wf_private.submit_request(jsonb)'::regprocedure);
  review_definition text := pg_catalog.pg_get_functiondef('wf_private.review_request(jsonb)'::regprocedure);
begin
  if position('SUPERSEDED_BY_NEW_CHECKIN' in attendance_definition)=0
    or position('work_date=day' in attendance_definition)=0 then
    raise exception 'Attendance session rollover patch was not installed';
  end if;
  if position('Không thể tạo bảng công cho ngày cần xử lý.' in submit_definition)=0
    or position('requested_start_at' in submit_definition)=0 then
    raise exception 'Missing-attendance request patch was not installed';
  end if;
  if position('TIMESHEET_EXPLANATION_APPROVED' in review_definition)=0
    or position('SUPERSEDED_BY_NEW_CHECKIN' in review_definition)=0 then
    raise exception 'Explanation/correction review patch was not installed';
  end if;
end;
$verify$;

notify pgrst, 'reload schema';
