-- Tighten two conditions before enabling the production UI.
do $fix$
declare definition text; previous text;
begin
 definition:=pg_get_functiondef('wf_private.attendance(jsonb)'::regprocedure); previous:=definition;
 definition:=replace(definition,'from public.shift_assignments where employee_id=a.employee_id and work_date=day;','from public.shift_assignments where employee_id=a.employee_id and work_date=day and publication_status=''PUBLISHED'';');
 if definition=previous then raise exception 'Unexpected attendance function; draft-schedule guard not applied'; end if;
 insert into wf_private.upgrade_snapshots(release,source_table,source_id,reason,row_data) values('workforce-v3-authorization-fix','function','wf_private.attendance(jsonb)','Draft schedules cannot authorize location or expected hours',jsonb_build_object('definition',previous)) on conflict do nothing;
 execute definition;
 definition:=pg_get_functiondef('wf_private.review_request(jsonb)'::regprocedure); previous:=definition;
 definition:=replace(definition,'not(r.fallback_to=a.employee_id and r.due_at<clock_timestamp())','not coalesce(r.fallback_to=a.employee_id and r.due_at<clock_timestamp(),false)');
 if definition=previous then raise exception 'Unexpected reviewer function; NULL-safe reviewer guard not applied'; end if;
 insert into wf_private.upgrade_snapshots(release,source_table,source_id,reason,row_data) values('workforce-v3-authorization-fix','function','wf_private.review_request(jsonb)','Unassigned fallback must not bypass reviewer ownership',jsonb_build_object('definition',previous)) on conflict do nothing;
 execute definition;
end $fix$;
notify pgrst,'reload schema';