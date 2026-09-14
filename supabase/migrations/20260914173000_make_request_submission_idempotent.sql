-- Serialize request submission per employee and let browsers safely replay an
-- ambiguous network response without creating a second workflow item.
set local lock_timeout='5s';
set local statement_timeout='120s';

alter table public.attendance_requests
  add column client_request_id uuid;

comment on column public.attendance_requests.client_request_id is
  'Opaque idempotency key generated once by the client for one logical submission.';

create unique index attendance_requests_client_request_id_key
  on public.attendance_requests(organization_id,employee_id,client_request_id)
  where client_request_id is not null;

do $patch$
declare
  definition text;
  old_fragment text:=$old$ owner_id text; backup_id text; requested_start_at timestamptz; requested_end_at timestamptz;
 first_day date:=(p->>'from_date')::date; last_day date:=coalesce((p->>'to_date')::date,(p->>'from_date')::date);$old$;
  new_fragment text:=$new$ owner_id text; backup_id text; requested_start_at timestamptz; requested_end_at timestamptz;
 client_id uuid:=case when nullif(trim(coalesce(p->>'client_request_id','')),'') is null then null else (p->>'client_request_id')::uuid end;
 first_day date:=(p->>'from_date')::date; last_day date:=coalesce((p->>'to_date')::date,(p->>'from_date')::date);$new$;
begin
  definition:=pg_catalog.pg_get_functiondef('wf_private.submit_request(jsonb)'::regprocedure);
  if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment)<>1 then
    raise exception 'Could not safely add request idempotency declaration';
  end if;
  execute replace(definition,old_fragment,new_fragment);
end;
$patch$;

do $patch$
declare
  definition text;
  old_fragment text:=$old$begin
 a:=wf_private.require_capability('request.submit');
 if kind not in ('EXPLANATION','CORRECTION','ANNUAL_LEAVE','SICK_LEAVE','UNPAID_LEAVE','BUSINESS_TRIP','REMOTE_WORK','SHIFT_SWAP','OVERTIME') or length(why) not between 5 and 1000 then raise exception 'Chọn loại yêu cầu và nhập lý do từ 5 đến 1.000 ký tự.'; end if;$old$;
  new_fragment text:=$new$begin
 a:=wf_private.require_capability('request.submit');
 perform pg_advisory_xact_lock(hashtextextended('request-submit:'||a.organization_id::text||':'||a.employee_id,0));
 if client_id is not null then
  select * into r
  from public.attendance_requests
  where organization_id=a.organization_id
    and employee_id=a.employee_id
    and client_request_id=client_id;
  if found then
   if r.request_type is distinct from kind or r.from_date is distinct from first_day
    or r.to_date is distinct from last_day or r.reason is distinct from why
    or r.requested_checkin is distinct from (p->>'requested_checkin')::timestamptz
    or r.requested_checkout is distinct from (p->>'requested_checkout')::timestamptz
    or (kind='SHIFT_SWAP' and coalesce(r.workflow_data->>'peer_employee_id','')<>coalesce(p->>'peer_employee_id','')) then
    raise exception 'Mã gửi yêu cầu đã được dùng cho nội dung khác.' using errcode='22023';
   end if;
   return jsonb_build_object('ok',true,'request',to_jsonb(r),'replayed',true);
  end if;
 end if;
 if kind not in ('EXPLANATION','CORRECTION','ANNUAL_LEAVE','SICK_LEAVE','UNPAID_LEAVE','BUSINESS_TRIP','REMOTE_WORK','SHIFT_SWAP','OVERTIME') or length(why) not between 5 and 1000 then raise exception 'Chọn loại yêu cầu và nhập lý do từ 5 đến 1.000 ký tự.'; end if;$new$;
begin
  definition:=pg_catalog.pg_get_functiondef('wf_private.submit_request(jsonb)'::regprocedure);
  if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment)<>1 then
    raise exception 'Could not safely install request replay guard';
  end if;
  execute replace(definition,old_fragment,new_fragment);
end;
$patch$;

do $patch$
declare
  definition text;
  old_fragment text:=$old$ if exists(select 1 from public.attendance_requests where employee_id=a.employee_id and status='PENDING' and request_type=kind and daterange(from_date,to_date,'[]') && daterange(first_day,last_day,'[]')) then raise exception 'Đã có yêu cầu tương tự đang chờ duyệt.'; end if;$old$;
  new_fragment text:=$new$ if exists(select 1 from public.attendance_requests where organization_id=a.organization_id and employee_id=a.employee_id and status='PENDING' and request_type=kind and daterange(from_date,to_date,'[]') && daterange(first_day,last_day,'[]')) then raise exception 'Đã có yêu cầu tương tự đang chờ duyệt.'; end if;$new$;
begin
  definition:=pg_catalog.pg_get_functiondef('wf_private.submit_request(jsonb)'::regprocedure);
  if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment)<>1 then
    raise exception 'Could not safely tenant-scope duplicate request guard';
  end if;
  execute replace(definition,old_fragment,new_fragment);
end;
$patch$;

do $patch$
declare
  definition text;
  old_fragment text:=$old$ insert into public.attendance_requests(timesheet_id,employee_id,request_type,reason,status,from_date,to_date,requested_checkin,requested_checkout,assigned_to,fallback_to,workflow_data)
 values(t.id,a.employee_id,kind,why,'PENDING',first_day,last_day,(p->>'requested_checkin')::timestamptz,(p->>'requested_checkout')::timestamptz,owner_id,backup_id,detail) returning * into r;$old$;
  new_fragment text:=$new$ insert into public.attendance_requests(timesheet_id,employee_id,request_type,reason,status,from_date,to_date,requested_checkin,requested_checkout,assigned_to,fallback_to,workflow_data,client_request_id)
 values(t.id,a.employee_id,kind,why,'PENDING',first_day,last_day,(p->>'requested_checkin')::timestamptz,(p->>'requested_checkout')::timestamptz,owner_id,backup_id,detail,client_id) returning * into r;$new$;
begin
  definition:=pg_catalog.pg_get_functiondef('wf_private.submit_request(jsonb)'::regprocedure);
  if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment)<>1 then
    raise exception 'Could not safely persist request idempotency key';
  end if;
  execute replace(definition,old_fragment,new_fragment);
end;
$patch$;

do $verify$
declare
  definition text:=pg_catalog.pg_get_functiondef('wf_private.submit_request(jsonb)'::regprocedure);
begin
  if position('client_request_id=client_id' in definition)=0
    or position('request-submit:' in definition)=0
    or position('''replayed'',true' in definition)=0 then
    raise exception 'Request idempotency hardening was not installed';
  end if;
end;
$verify$;

notify pgrst,'reload schema';
