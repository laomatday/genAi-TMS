-- Atomically install the reviewed notification/automation SQL from a pinned commit.
set local lock_timeout='5s';
set local statement_timeout='120s';
do $release$
declare source_commit constant text:='d36a5e8528e199e0af7f5e1c5272630ea10158dd';
 manifest jsonb:='[{"path":"workforce_delivery.sql","sha":"edf91815bc1b959cc1e32a986b9772014da41988"},{"path":"workforce_delivery_fixes.sql","sha":"04fd45148d1389e091bb8f1e17e6767b483f5e42"}]';
 item jsonb; response record; body text; bytes bytea; actual_sha text;
 bodies text[]:='{}'; paths text[]:='{}'; hashes text[]:='{}'; i integer; had_http boolean;
 before_counts jsonb; after_counts jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('genai:workforce:experience-release',0));
 if to_regclass('wf_private.delivery_config') is not null then raise exception 'Delivery release already exists; inspect migration history'; end if;
 select jsonb_build_object('employees',(select count(*) from public.employees),'timesheets',(select count(*) from public.timesheets),'events',(select count(*) from public.attendance_events),'requests',(select count(*) from public.attendance_requests)) into before_counts;
 select exists(select 1 from pg_extension where extname='http') into had_http;
 if not had_http then execute 'create extension http with schema extensions';end if;
 for item in select value from jsonb_array_elements(manifest) loop
  execute 'select status,content from extensions.http_get($1)' into response using 'https://raw.githubusercontent.com/laomatday/genai-erp/'||source_commit||'/database/pending/'||(item->>'path');
  if response.status<>200 or response.content is null then raise exception 'Could not fetch source %',item->>'path';end if;
  body:=response.content;bytes:=convert_to(body,'UTF8');
  actual_sha:=encode(extensions.digest(convert_to('blob '||octet_length(bytes)::text,'UTF8')||decode('00','hex')||bytes,'sha1'),'hex');
  if actual_sha is distinct from item->>'sha' then raise exception 'Source verification failed for %',item->>'path';end if;
  bodies:=array_append(bodies,body);paths:=array_append(paths,item->>'path');hashes:=array_append(hashes,actual_sha);
 end loop;
 if cardinality(bodies)<>2 then raise exception 'Incomplete source release';end if;
 for i in 1..cardinality(bodies) loop execute bodies[i];end loop;
 for i in 1..cardinality(bodies) loop
  insert into wf_private.release_sources(release,ordinal,source_commit,source_path,git_blob_sha,sql_body) values('workforce-experience-delivery',i,source_commit,'database/pending/'||paths[i],hashes[i],bodies[i]);
 end loop;
 if has_function_privilege('anon','public.workforce_notifications_v1(text,jsonb)','execute') or has_function_privilege('authenticated','public.workforce_push_worker_v1(text,jsonb)','execute') then raise exception 'Unexpected public worker access';end if;
 if not has_function_privilege('authenticated','public.workforce_notifications_v1(text,jsonb)','execute') or not has_function_privilege('service_role','public.workforce_push_worker_v1(text,jsonb)','execute') then raise exception 'Missing authorized handler grants';end if;
 select jsonb_build_object('employees',(select count(*) from public.employees),'timesheets',(select count(*) from public.timesheets),'events',(select count(*) from public.attendance_events),'requests',(select count(*) from public.attendance_requests)) into after_counts;
 if before_counts<>after_counts then raise exception 'Business row counts changed unexpectedly';end if;
 insert into wf_private.upgrade_snapshots(release,source_table,source_id,reason,row_data) values('workforce-experience-delivery','deployment',source_commit,'Pinned source verified; business rows preserved; opt-in channels remain disabled',jsonb_build_object('before',before_counts,'after',after_counts,'files',manifest));
 if not had_http then execute 'drop extension http';end if;
end $release$;
notify pgrst,'reload schema';