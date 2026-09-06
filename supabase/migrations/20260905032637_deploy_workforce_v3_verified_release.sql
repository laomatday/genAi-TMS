-- Release: laomatday/genai-erp@f92cc58d9b54e3e50d382c42b25479212ac9b183
-- Only the seven reviewed, immutable Git blobs below may execute.
-- All schema/data changes and the temporary HTTP extension are transactional.
set local lock_timeout = '5s';
set local statement_timeout = '120s';
do $release$
declare
  source_commit constant text := 'f92cc58d9b54e3e50d382c42b25479212ac9b183';
  manifest jsonb := '[{"path":"00_stability.sql","sha":"70b1cade198ec8a89ec3bc21b0b8ac45a85f474e"},{"path":"00a_event_metadata.sql","sha":"ff10bcbb313524ab36d6be0ee0bebca5a29f9d17"},{"path":"01_workforce_core.sql","sha":"c9fa0c5a43024e26a844ba77b643cd9c5bd84f22"},{"path":"01a_event_metadata_verified.sql","sha":"1225b4605a0529b90b1ab0b898c479c0c0721f0d"},{"path":"02_workforce_operations.sql","sha":"8112daf19b5135791ed16433da53e3628fd008c4"},{"path":"03_maintenance_payroll.sql","sha":"2d0c58432ba972c20f3e665f0c2afb6f248e7f79"},{"path":"04_workforce_api.sql","sha":"170f3e1f3b08261de109e4eba0bda058a71f0ca8"}]'::jsonb;
  item jsonb; response record; body text; body_bytes bytea; actual_sha text;
  bodies text[] := array[]::text[]; paths text[] := array[]::text[];
  hashes text[] := array[]::text[]; i integer; had_http boolean;
  before_counts jsonb; after_counts jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('genai:workforce-v3:release',0));
  if to_regprocedure('public.workforce_query(text,jsonb)') is not null or to_regclass('public.organizations') is not null then
    raise exception 'Workforce release is already present or partially installed; inspect migration history before continuing.';
  end if;
  if to_regprocedure('public.refresh_tms_exceptions_v2(date,date)') is null then raise exception 'Required baseline RPC is missing'; end if;
  if exists(select 1 from public.attendance_requests) or exists(select 1 from public.leave_requests) or exists(select 1 from public.attendance_explanations) then
    raise exception 'Existing request data requires an explicit reviewed backfill before this release';
  end if;
  select jsonb_build_object('employees',(select count(*) from public.employees),'timesheets',(select count(*) from public.timesheets),'attendance_events',(select count(*) from public.attendance_events),'legacy_attendance',(select count(*) from public.attendance),'auth_users',(select count(*) from auth.users)) into before_counts;
  select exists(select 1 from pg_extension where extname='http') into had_http;
  if not had_http then execute 'create extension http with schema extensions'; end if;
  -- Download public code only; never send credentials or database rows over HTTP.
  for item in select value from jsonb_array_elements(manifest) loop
    execute 'select status, content from extensions.http_get($1)' into response
      using 'https://raw.githubusercontent.com/laomatday/genai-erp/'||source_commit||'/database/releases/'||(item->>'path');
    if response.status<>200 or response.content is null then raise exception 'Could not fetch pinned release file % (HTTP %)',item->>'path',response.status; end if;
    body := response.content;
    body_bytes := convert_to(body,'UTF8');
    actual_sha := encode(extensions.digest(convert_to('blob '||octet_length(body_bytes)::text,'UTF8')||decode('00','hex')||body_bytes,'sha1'),'hex');
    if actual_sha is distinct from item->>'sha' then raise exception 'Git blob verification failed for %',item->>'path'; end if;
    bodies:=array_append(bodies,body); paths:=array_append(paths,item->>'path'); hashes:=array_append(hashes,actual_sha);
  end loop;
  if cardinality(bodies)<>7 then raise exception 'Incomplete release'; end if;
  -- No application changes occur until every pinned blob has been verified.
  for i in 1..cardinality(bodies) loop execute bodies[i]; end loop;
  execute 'create table wf_private.release_sources (release text not null, ordinal integer not null, source_commit text not null, source_path text not null, git_blob_sha text not null, sql_body text not null, applied_at timestamptz not null default clock_timestamp(), primary key(release,ordinal))';
  execute 'revoke all on wf_private.release_sources from public,anon,authenticated';
  for i in 1..cardinality(bodies) loop
    execute 'insert into wf_private.release_sources(release,ordinal,source_commit,source_path,git_blob_sha,sql_body) values($1,$2,$3,$4,$5,$6)'
      using 'workforce-v3',i,source_commit,'database/releases/'||paths[i],hashes[i],bodies[i];
  end loop;
  select jsonb_build_object('employees',(select count(*) from public.employees),'timesheets',(select count(*) from public.timesheets),'attendance_events',(select count(*) from public.attendance_events),'legacy_attendance',(select count(*) from public.attendance),'auth_users',(select count(*) from auth.users)) into after_counts;
  if before_counts<>after_counts then raise exception 'Unexpected row count change: before %, after %',before_counts,after_counts; end if;
  if to_regprocedure('public.workforce_query(text,jsonb)') is null or to_regprocedure('public.workforce_command(text,jsonb)') is null then raise exception 'Required Workforce API was not installed'; end if;
  if has_function_privilege('anon','public.workforce_query(text,jsonb)','execute') or has_function_privilege('anon','public.workforce_command(text,jsonb)','execute') then raise exception 'Anonymous access must remain denied'; end if;
  if not has_function_privilege('authenticated','public.workforce_query(text,jsonb)','execute') or not has_function_privilege('authenticated','public.workforce_command(text,jsonb)','execute') then raise exception 'Authenticated API grants missing'; end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and (c.relname='organizations' or c.relname like 'workforce_%') and c.relkind='r' and not c.relrowsecurity) then raise exception 'RLS is missing on a new table'; end if;
  insert into wf_private.upgrade_snapshots(release,source_table,source_id,reason,row_data)
    values('workforce-v3-deploy','deployment',source_commit,'Verified source, pre/post row counts and API privilege checks',jsonb_build_object('before',before_counts,'after',after_counts,'files',manifest));
  if not had_http then execute 'drop extension http'; end if;
end $release$;
notify pgrst,'reload schema';