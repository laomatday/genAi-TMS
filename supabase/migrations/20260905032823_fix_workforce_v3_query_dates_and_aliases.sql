-- Fix runtime-only defects found by executing all resources after deployment.
-- Preserve semantics; correct interval syntax and eliminate PL/pgSQL row/SQL alias collisions.
do $fix$
declare f record; definition text; before_definition text; start_at integer; end_at integer; bootstrap text;
begin
 for f in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='wf_private' and p.prokind='f' and p.prosrc like '%1 month-1 day%' loop
  definition:=pg_get_functiondef(f.oid); before_definition:=definition;
  definition:=replace(definition,'1 month-1 day','1 month - 1 day');
  insert into wf_private.upgrade_snapshots(release,source_table,source_id,reason,row_data)
    values('workforce-v3-runtime-fix','function',f.oid::regprocedure::text,'Correct invalid interval literal',jsonb_build_object('definition',before_definition)) on conflict do nothing;
  execute definition;
 end loop;
 definition:=pg_get_functiondef('wf_private.query(text,jsonb)'::regprocedure);
 before_definition:=definition;
 definition:=replace(definition,' t public.timesheets%rowtype;',' current_sheet public.timesheets%rowtype;');
 definition:=replace(definition,' sa public.shift_assignments%rowtype;',' planned_assignment public.shift_assignments%rowtype;');
 start_at:=strpos(definition,'if p_resource=''bootstrap'' then');
 end_at:=strpos(definition,'elsif p_resource=''history'' then');
 if start_at=0 or end_at<=start_at then raise exception 'Unexpected query function structure'; end if;
 bootstrap:=substring(definition from start_at for end_at-start_at);
 bootstrap:=replace(bootstrap,'into t from public.timesheets','into current_sheet from public.timesheets');
 bootstrap:=replace(bootstrap,'into sa from public.shift_assignments','into planned_assignment from public.shift_assignments');
 bootstrap:=replace(bootstrap,'t.id','current_sheet.id');
 bootstrap:=replace(bootstrap,'to_jsonb(t)','to_jsonb(current_sheet)');
 bootstrap:=regexp_replace(bootstrap,'\msa\.','planned_assignment.','g');
 definition:=substring(definition from 1 for start_at-1)||bootstrap||substring(definition from end_at);
 if definition=before_definition then raise exception 'Query alias repair was not applied'; end if;
 insert into wf_private.upgrade_snapshots(release,source_table,source_id,reason,row_data)
 values('workforce-v3-runtime-fix','function','wf_private.query(text,jsonb)','Rename bootstrap row variables to avoid table aliases',jsonb_build_object('definition',before_definition)) on conflict do nothing;
 execute definition;
end $fix$;
notify pgrst,'reload schema';