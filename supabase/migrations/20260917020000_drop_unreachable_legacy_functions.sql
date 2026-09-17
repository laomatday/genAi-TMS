-- Removes seven functions nothing can reach.
--
--   public.tms_dashboard_bundle_v1(integer)          the old one-shot dashboard
--     -> public.tms_directory_context_v1()             RPC and the two helpers
--       -> tms_private.directory_context_v1()          it called
--
--   public.update_qr_station_admin(uuid,text,text,boolean)   station editing,
--     -> tms_private.update_qr_station_admin_v1(...)         now a workforce_command
--
--   public.workforce_notifications_v1(text,jsonb)    superseded notification RPC
--   tms_private.employee_json(public.employees)      row serializer, no callers
--
-- "Unreachable" is meant literally, not as shorthand for unused. None of the
-- seven is granted EXECUTE to anon, authenticated or service_role, so PostgREST
-- will not call them for anybody; none appears in an RLS policy, a trigger, a
-- column default, a check constraint, an index or a cron command; and the only
-- callers any of them have are each other. The three chains above are closed.
--
-- The dashboard bundle is the reason the readiness guard exists in its current
-- shape: it is the monolithic RPC that workforce_query's bootstrap/today split
-- replaced, and scripts/verify-production-readiness.mjs already fails the build
-- if the load test so much as mentions it. Its references in that script, and
-- the others here, are assertions about the text of old migration files, not
-- evidence that the functions are live — which is worth saying plainly, because
-- a grep for these names hits the guard and looks like proof of the opposite.
--
-- Deliberately spared, though a reference scan calls them equally unused:
--
--   wf_private.dispatch_push, push_worker, delivery_user, delivery_secret,
--   allowed_push_endpoint, public.workforce_push_worker_v1
--   public.workforce_hris_worker_v1, public.workforce_maintenance_worker_v1
--
-- Those are granted to service_role, so something outside this database can
-- call them, and the push chain is the server half of a feature the roadmap
-- schedules first — the browser has simply never called pushManager.subscribe.
-- Deleting them would not be cleanup, it would be removing unshipped work.

begin;

do $migration$
declare
  doomed text[]:=array[
    -- callers before the functions they call
    'public.tms_dashboard_bundle_v1(integer)',
    'public.tms_directory_context_v1()',
    'tms_private.directory_context_v1()',
    'public.update_qr_station_admin(uuid,text,text,boolean)',
    'tms_private.update_qr_station_admin_v1(uuid,text,text,boolean)',
    'public.workforce_notifications_v1(text,jsonb)',
    'tms_private.employee_json(public.employees)'
  ];
  target text;
  bare text;
  survivor text;
  target_oid oid;
  doomed_oids oid[];
begin
  -- Resolved to oids up front, so "is this caller also on the list?" is asked
  -- by identity rather than by matching signature text. Comparing the strings
  -- does not work: the array above writes argument types only, while
  -- pg_get_function_identity_arguments writes names too, so
  -- tms_dashboard_bundle_v1 failed to recognise itself and the check reported
  -- one doomed function as a reason to keep another.
  select array_agg(sig::regprocedure) into doomed_oids from unnest(doomed) sig;

  -- Re-checked here rather than trusted from the comment above, because the
  -- schema may have moved since this file was written.
  foreach target in array doomed loop
    target_oid:=target::regprocedure;
    bare:=split_part(split_part(target,'(',1),'.',2);

    select r.rolname into survivor
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a, pg_roles r
    where p.oid=target_oid and r.oid=a.grantee
      and a.privilege_type='EXECUTE' and r.rolname in ('anon','authenticated','service_role')
    limit 1;
    if survivor is not null then
      raise exception '% is callable by %, refusing to drop it', target, survivor;
    end if;

    select n.nspname||'.'||p.proname into survivor
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','wf_private','tms_private')
      and not (p.oid = any(doomed_oids))
      and p.prosrc ~ ('\m'||bare||'\M')
    limit 1;
    if survivor is not null then
      raise exception '% is called by %, refusing to drop it', target, survivor;
    end if;

    select 'an RLS policy' into survivor from pg_policy p
    where pg_get_expr(p.polqual,p.polrelid) ~ ('\m'||bare||'\M')
       or coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'') ~ ('\m'||bare||'\M')
    limit 1;
    if survivor is not null then
      raise exception '% is used by %, refusing to drop it', target, survivor;
    end if;

    select 'a column default' into survivor from pg_attrdef d
    where pg_get_expr(d.adbin,d.adrelid) ~ ('\m'||bare||'\M') limit 1;
    if survivor is not null then
      raise exception '% is used by %, refusing to drop it', target, survivor;
    end if;

    select 'a trigger' into survivor from pg_trigger t
    where t.tgfoid=target_oid and not t.tgisinternal limit 1;
    if survivor is not null then
      raise exception '% is used by %, refusing to drop it', target, survivor;
    end if;

    select 'a cron job' into survivor from cron.job j
    where j.command ~ ('\m'||bare||'\M') limit 1;
    if survivor is not null then
      raise exception '% is used by %, refusing to drop it', target, survivor;
    end if;
  end loop;

  foreach target in array doomed loop
    execute format('drop function %s', target);
  end loop;
end;
$migration$;

do $verify$
declare remaining text;
begin
  select string_agg(sig, ', ') into remaining
  from unnest(array[
    'public.tms_dashboard_bundle_v1(integer)',
    'public.tms_directory_context_v1()',
    'tms_private.directory_context_v1()',
    'public.update_qr_station_admin(uuid,text,text,boolean)',
    'tms_private.update_qr_station_admin_v1(uuid,text,text,boolean)',
    'public.workforce_notifications_v1(text,jsonb)',
    'tms_private.employee_json(public.employees)'
  ]) sig
  where to_regprocedure(sig) is not null;
  if remaining is not null then
    raise exception 'functions survived the drop: %', remaining;
  end if;

  -- The two RPCs the browser actually calls have to still be there, and still
  -- callable by a signed-in user.
  if to_regprocedure('public.workforce_query(text,jsonb)') is null
    or to_regprocedure('public.workforce_command(text,jsonb)') is null then
    raise exception 'a live Workforce entry point was removed';
  end if;
  if not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a, pg_roles r
    where p.oid='public.workforce_query(text,jsonb)'::regprocedure
      and r.oid=a.grantee and r.rolname='authenticated' and a.privilege_type='EXECUTE'
  ) then
    raise exception 'workforce_query is no longer callable by authenticated';
  end if;
end;
$verify$;

commit;

notify pgrst, 'reload schema';
