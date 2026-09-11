-- Vendored release: laomatday/genai-erp@d36a5e8528e199e0af7f5e1c5272630ea10158dd
--
-- SECURITY/RELIABILITY FIX (2026-09-11): same issue and same fix as
-- supabase/migrations/20260905032637_deploy_workforce_v3_verified_release.sql — this migration
-- originally fetched the 2 files below over HTTPS from raw.githubusercontent.com/laomatday/genai-erp
-- at apply time. That source repository is no longer publicly reachable (confirmed via `curl` on
-- 2026-09-11: HTTP 404). This version inlines the exact same SQL, byte-for-byte, with no logic
-- change, extracted from wf_private.release_sources (archived by the original migration on
-- 2026-09-05) and independently re-verified against the pinned git-blob SHA1 hashes below.
set local lock_timeout='5s';
set local statement_timeout='120s';

do $guard$
begin
  if to_regclass('wf_private.delivery_config') is not null then raise exception 'Delivery release already exists; inspect migration history'; end if;
end $guard$;

-- ============================================================================
-- database/pending/workforce_delivery.sql  (git blob edf91815bc1b959cc1e32a986b9772014da41988)
-- ============================================================================
-- Opt-in Web Push and observable scheduled maintenance. No business evidence is deleted.
create table wf_private.automation_runs (
 id uuid primary key default extensions.gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 started_at timestamptz not null default clock_timestamp(), finished_at timestamptz,
 status text not null check(status in ('RUNNING','SUCCESS','FAILED')), changed integer not null default 0, error_code text
);
create index workforce_automation_window on wf_private.automation_runs(organization_id,started_at desc);
create table wf_private.delivery_config (
 singleton boolean primary key default true check(singleton), public_key text, private_secret_id uuid, dispatch_secret_id uuid,
 function_url text, maintenance_enabled boolean not null default false, push_enabled boolean not null default false,
 worker_last_seen timestamptz, dispatched_at timestamptz
);
insert into wf_private.delivery_config(singleton) values(true);
create table wf_private.push_subscriptions (
 id uuid primary key default extensions.gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 employee_id text not null references public.employees(employee_id), endpoint text not null unique,
 p256dh text not null, auth_key text not null, enabled boolean not null default true,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);
create index workforce_push_employee on wf_private.push_subscriptions(employee_id) where enabled;
create table wf_private.push_deliveries (
 id uuid primary key default extensions.gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 subscription_id uuid not null references wf_private.push_subscriptions(id), notification_id uuid not null references public.workforce_notifications(id),
 status text not null default 'PENDING' check(status in ('PENDING','PROCESSING','RETRY','ACCEPTED','FAILED','CANCELLED')),
 attempts integer not null default 0, next_attempt_at timestamptz not null default clock_timestamp(),
 lease_token uuid, claimed_at timestamptz, completed_at timestamptz, last_code text,
 created_at timestamptz not null default clock_timestamp(), unique(subscription_id,notification_id)
);
create index workforce_push_queue on wf_private.push_deliveries(status,next_attempt_at);
revoke all on wf_private.automation_runs,wf_private.delivery_config,wf_private.push_subscriptions,wf_private.push_deliveries from public,anon,authenticated,service_role;
alter table wf_private.automation_runs enable row level security;
alter table wf_private.delivery_config enable row level security;
alter table wf_private.push_subscriptions enable row level security;
alter table wf_private.push_deliveries enable row level security;

create function wf_private.allowed_push_endpoint(p_endpoint text) returns boolean language sql immutable set search_path=''
as $$ select char_length(p_endpoint) between 30 and 2048 and p_endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/[^[:space:]#]+$' $$;

create function wf_private.delivery_user(p_action text,p jsonb) returns jsonb language plpgsql security definer set search_path=''
as $fn$
declare a public.employees%rowtype; cfg wf_private.delivery_config%rowtype; endpoint text; dh text; auth_key text; sid uuid; previous_employee text;
begin
 a:=wf_private.actor(); select * into cfg from wf_private.delivery_config where singleton;
 endpoint:=p->>'endpoint';
 if p_action='settings' then
  return jsonb_build_object('ready',cfg.public_key is not null and cfg.push_enabled,'public_key',cfg.public_key,
   'subscribed',exists(select 1 from wf_private.push_subscriptions s where s.employee_id=a.employee_id and s.endpoint=endpoint and s.enabled));
 elsif p_action='health' then
  perform wf_private.require_capability('audit.view');
  return jsonb_build_object('maintenance_enabled',cfg.maintenance_enabled,'push_enabled',cfg.push_enabled,
   'last_run',(select to_jsonb(r) from wf_private.automation_runs r where organization_id=a.organization_id order by started_at desc limit 1),
   'worker_last_seen',cfg.worker_last_seen,'subscriptions',(select count(*) from wf_private.push_subscriptions where organization_id=a.organization_id and enabled),
   'pending',(select count(*) from wf_private.push_deliveries where organization_id=a.organization_id and status in ('PENDING','PROCESSING','RETRY')),
   'accepted_7d',(select count(*) from wf_private.push_deliveries where organization_id=a.organization_id and status='ACCEPTED' and created_at>clock_timestamp()-interval '7 days'),
   'failed_7d',(select count(*) from wf_private.push_deliveries where organization_id=a.organization_id and status='FAILED' and created_at>clock_timestamp()-interval '7 days'));
 elsif p_action='subscribe' then
  if cfg.public_key is null or not cfg.push_enabled then raise exception 'Kênh thông báo thiết bị chưa sẵn sàng.'; end if;
  if p->>'public_key' is distinct from cfg.public_key then raise exception 'Khóa thông báo đã thay đổi. Cập nhật ứng dụng rồi thử lại.'; end if;
  endpoint:=p->'subscription'->>'endpoint'; dh:=p->'subscription'->'keys'->>'p256dh'; auth_key:=p->'subscription'->'keys'->>'auth';
  if not coalesce(wf_private.allowed_push_endpoint(endpoint),false) or not coalesce(dh ~ '^[A-Za-z0-9_-]{87}$',false) or not coalesce(auth_key ~ '^[A-Za-z0-9_-]{22}$',false) then raise exception 'Đăng ký thông báo không hợp lệ.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('workforce-push:'||a.employee_id,0));
  if (select count(*) from wf_private.push_subscriptions where employee_id=a.employee_id and enabled and endpoint<>delivery_user.endpoint)>=5 then raise exception 'Mỗi tài khoản chỉ bật tối đa 5 thiết bị.'; end if;
  select s.id,s.employee_id into sid,previous_employee from wf_private.push_subscriptions s where s.endpoint=delivery_user.endpoint for update;
  if sid is not null and previous_employee<>a.employee_id then
   update wf_private.push_deliveries set status='CANCELLED',completed_at=clock_timestamp() where subscription_id=sid and status in ('PENDING','PROCESSING','RETRY');
  end if;
  -- Explicit consent binds this browser endpoint to the currently authenticated account.
  insert into wf_private.push_subscriptions(organization_id,employee_id,endpoint,p256dh,auth_key)
  values(a.organization_id,a.employee_id,endpoint,dh,auth_key)
  on conflict(endpoint) do update set organization_id=excluded.organization_id,employee_id=excluded.employee_id,p256dh=excluded.p256dh,auth_key=excluded.auth_key,enabled=true,updated_at=clock_timestamp()
  returning id into sid;
  return jsonb_build_object('ok',true,'subscribed',true);
 elsif p_action='unsubscribe' then
  if endpoint is null or char_length(endpoint)>2048 then raise exception 'Thiếu đăng ký cần tắt.'; end if;
  update wf_private.push_subscriptions s set enabled=false,updated_at=clock_timestamp() where s.endpoint=delivery_user.endpoint and s.employee_id=a.employee_id returning s.id into sid;
  if sid is not null then update wf_private.push_deliveries set status='CANCELLED',completed_at=clock_timestamp() where subscription_id=sid and status in ('PENDING','PROCESSING','RETRY'); end if;
  return jsonb_build_object('ok',true,'subscribed',false);
 end if;
 raise exception 'Unknown notification action' using errcode='22023';
end $fn$;

create function wf_private.enqueue_push() returns trigger language plpgsql security definer set search_path=''
as $$ begin
 insert into wf_private.push_deliveries(organization_id,subscription_id,notification_id)
 select new.organization_id,s.id,new.id from wf_private.push_subscriptions s join public.employees e on e.employee_id=s.employee_id
 where s.employee_id=new.employee_id and s.organization_id=new.organization_id and s.enabled and e.status='Active'
 on conflict do nothing;
 return new;
end $$;
create trigger workforce_notification_push after insert on public.workforce_notifications for each row execute function wf_private.enqueue_push();

create function wf_private.delivery_secret(p_id uuid) returns text language plpgsql security definer set search_path=''
as $$ declare value text; begin
 if p_id is null then return null; end if;
 execute 'select decrypted_secret from vault.decrypted_secrets where id=$1' into value using p_id;
 return value;
end $$;

create function wf_private.push_worker(p_action text,p jsonb) returns jsonb language plpgsql security definer set search_path=''
as $fn$
declare cfg wf_private.delivery_config%rowtype; secret_id uuid; rows jsonb; row wf_private.push_deliveries%rowtype; success boolean; code text;
begin
 if p_action='config' then
  select * into cfg from wf_private.delivery_config where singleton;
  return jsonb_build_object('enabled',cfg.push_enabled,'dispatch_secret',wf_private.delivery_secret(cfg.dispatch_secret_id),
   'public_key',cfg.public_key,'private_key',wf_private.delivery_secret(cfg.private_secret_id));
 elsif p_action='initialize' then
  select * into cfg from wf_private.delivery_config where singleton for update;
  if cfg.public_key is null then
   if not coalesce((p->>'public_key') ~ '^[A-Za-z0-9_-]{87}$',false) or not coalesce((p->>'private_key') ~ '^[A-Za-z0-9_-]{43}$',false) then raise exception 'Invalid VAPID key pair'; end if;
   execute 'select vault.create_secret($1,$2)' into secret_id using p->>'private_key','workforce-vapid-private-v1';
   update wf_private.delivery_config set public_key=p->>'public_key',private_secret_id=secret_id where singleton;
  end if;
  return jsonb_build_object('ok',true);
 elsif p_action='claim' then
  update wf_private.delivery_config set worker_last_seen=clock_timestamp() where singleton;
  update wf_private.push_deliveries d set status='CANCELLED',completed_at=clock_timestamp(),last_code='EXPIRED_OR_INACTIVE'
  where d.status in ('PENDING','PROCESSING','RETRY') and (d.created_at<clock_timestamp()-interval '24 hours' or not exists(
   select 1 from wf_private.push_subscriptions s join public.employees e on e.employee_id=s.employee_id join public.workforce_notifications n on n.id=d.notification_id
   where s.id=d.subscription_id and s.enabled and e.status='Active' and s.employee_id=n.employee_id and s.organization_id=n.organization_id and n.read_at is null));
  update wf_private.push_deliveries set status='FAILED',completed_at=clock_timestamp(),last_code='RETRY_LIMIT'
  where attempts>=5 and (status in ('PENDING','RETRY') or (status='PROCESSING' and claimed_at<clock_timestamp()-interval '2 minutes'));
  with candidates as (
   select id from wf_private.push_deliveries where attempts<5 and
    ((status in ('PENDING','RETRY') and next_attempt_at<=clock_timestamp()) or (status='PROCESSING' and claimed_at<clock_timestamp()-interval '2 minutes'))
   order by created_at for update skip locked limit 25
  ), claimed as (
   update wf_private.push_deliveries d set status='PROCESSING',lease_token=extensions.gen_random_uuid(),claimed_at=clock_timestamp(),attempts=attempts+1
   where id in(select id from candidates) returning d.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'lease',d.lease_token,'notification_id',d.notification_id,
   'subscription',jsonb_build_object('endpoint',s.endpoint,'keys',jsonb_build_object('p256dh',s.p256dh,'auth',s.auth_key)))),'[]') into rows
  from claimed d join wf_private.push_subscriptions s on s.id=d.subscription_id;
  return jsonb_build_object('items',rows);
 elsif p_action='finish' then
  select * into row from wf_private.push_deliveries where id=(p->>'id')::uuid and lease_token=(p->>'lease')::uuid and status='PROCESSING' for update;
  if not found then return jsonb_build_object('ok',false,'code','STALE_LEASE'); end if;
  success:=coalesce((p->>'accepted')::boolean,false); code:=left(regexp_replace(coalesce(p->>'code','UNKNOWN'),'[^A-Z0-9_]','_','g'),48);
  update wf_private.push_deliveries set status=case when success then 'ACCEPTED' when coalesce((p->>'retry')::boolean,false) and attempts<5 then 'RETRY' else 'FAILED' end,
   last_code=code,completed_at=case when success or not coalesce((p->>'retry')::boolean,false) or attempts>=5 then clock_timestamp() else null end,
   next_attempt_at=clock_timestamp()+make_interval(mins=>least(60,power(2,attempts)::integer)) where id=row.id;
  if coalesce((p->>'expired')::boolean,false) then update wf_private.push_subscriptions set enabled=false,updated_at=clock_timestamp() where id=row.subscription_id; end if;
  return jsonb_build_object('ok',true);
 end if;
 raise exception 'Unknown worker action';
end $fn$;

create function wf_private.run_automation() returns jsonb language plpgsql security definer set search_path=''
as $fn$
declare org record; run_id uuid; result jsonb; ok_count integer:=0; failed_count integer:=0;
begin
 if not pg_try_advisory_xact_lock(hashtextextended('workforce:scheduled-maintenance',0)) then return jsonb_build_object('skipped',true); end if;
 for org in select id from public.organizations order by id loop
  insert into wf_private.automation_runs(organization_id,status) values(org.id,'RUNNING') returning id into run_id;
  begin
   result:=wf_private.maintain(org.id);
   update wf_private.automation_runs set status='SUCCESS',finished_at=clock_timestamp(),changed=coalesce((result->>'changed')::integer,0) where id=run_id;
   ok_count:=ok_count+1;
  exception when others then
   update wf_private.automation_runs set status='FAILED',finished_at=clock_timestamp(),error_code=sqlstate where id=run_id;
   failed_count:=failed_count+1;
  end;
 end loop;
 return jsonb_build_object('ok',failed_count=0,'completed',ok_count,'failed',failed_count);
end $fn$;

create function wf_private.dispatch_push() returns bigint language plpgsql security definer set search_path=''
as $fn$
declare cfg wf_private.delivery_config%rowtype; request_id bigint; secret text;
begin
 select * into cfg from wf_private.delivery_config where singleton;
 if not cfg.push_enabled or cfg.function_url is null then return null; end if;
 if cfg.public_key is not null and not exists(select 1 from wf_private.push_deliveries where status in ('PENDING','PROCESSING','RETRY') and next_attempt_at<=clock_timestamp()) then return null; end if;
 secret:=wf_private.delivery_secret(cfg.dispatch_secret_id);
 if secret is null then raise exception 'Push dispatcher is not initialized'; end if;
 execute 'select net.http_post(url:=$1,body:=$2,headers:=$3,timeout_milliseconds:=25000)' into request_id
 using cfg.function_url,'{}'::jsonb,jsonb_build_object('Content-Type','application/json','x-genai-dispatch',secret);
 update wf_private.delivery_config set dispatched_at=clock_timestamp() where singleton;
 return request_id;
end $fn$;

create function public.workforce_notifications_v1(p_action text,p_args jsonb default '{}') returns jsonb language sql security invoker set search_path=''
as $$ select wf_private.delivery_user(p_action,p_args) $$;
create function public.workforce_push_worker_v1(p_action text,p_args jsonb default '{}') returns jsonb language sql security invoker set search_path=''
as $$ select wf_private.push_worker(p_action,p_args) $$;
revoke all on function public.workforce_notifications_v1(text,jsonb),public.workforce_push_worker_v1(text,jsonb) from public,anon,authenticated;
revoke all on function wf_private.allowed_push_endpoint(text),wf_private.delivery_user(text,jsonb),wf_private.enqueue_push(),wf_private.delivery_secret(uuid),wf_private.push_worker(text,jsonb),wf_private.run_automation(),wf_private.dispatch_push() from public,anon,authenticated,service_role;
grant execute on function public.workforce_notifications_v1(text,jsonb),wf_private.delivery_user(text,jsonb) to authenticated;
grant execute on function public.workforce_push_worker_v1(text,jsonb),wf_private.push_worker(text,jsonb) to service_role;
notify pgrst,'reload schema';

-- ============================================================================
-- database/pending/workforce_delivery_fixes.sql  (git blob 04fd45148d1389e091bb8f1e17e6767b483f5e42)
-- ============================================================================
-- Resolve SQL variable/column ambiguity before this draft is released.
do $fix$
declare definition text;
begin
 definition:=pg_get_functiondef('wf_private.delivery_user(text,jsonb)'::regprocedure);
 definition:=replace(definition,'endpoint text; dh text;','v_endpoint text; dh text;');
 definition:=replace(definition,'endpoint:=','v_endpoint:=');
 definition:=replace(definition,'delivery_user.endpoint','v_endpoint');
 definition:=replace(definition,'s.endpoint=endpoint','s.endpoint=v_endpoint');
 definition:=replace(definition,'allowed_push_endpoint(endpoint)','allowed_push_endpoint(v_endpoint)');
 definition:=replace(definition,'endpoint is null or char_length(endpoint)','v_endpoint is null or char_length(v_endpoint)');
 definition:=replace(definition,'a.employee_id,endpoint,dh,auth_key','a.employee_id,v_endpoint,dh,auth_key');
 execute definition;
 definition:=pg_get_functiondef('wf_private.dispatch_push()'::regprocedure);
 execute replace(definition,'timeout_milliseconds:=25000','timeout_milliseconds:=60000');
end $fix$;

do $verify$
begin
  if has_function_privilege('anon','public.workforce_notifications_v1(text,jsonb)','execute') or has_function_privilege('authenticated','public.workforce_push_worker_v1(text,jsonb)','execute') then raise exception 'Unexpected public worker access'; end if;
  if not has_function_privilege('authenticated','public.workforce_notifications_v1(text,jsonb)','execute') or not has_function_privilege('service_role','public.workforce_push_worker_v1(text,jsonb)','execute') then raise exception 'Missing authorized handler grants'; end if;
end $verify$;

insert into wf_private.release_sources (release, ordinal, source_commit, source_path, git_blob_sha, sql_body) values
  ('workforce-experience-delivery', 1, 'd36a5e8528e199e0af7f5e1c5272630ea10158dd', 'database/pending/workforce_delivery.sql', 'edf91815bc1b959cc1e32a986b9772014da41988', 'Vendored inline in supabase/migrations/20260905043052_workforce_experience_notification_delivery.sql on 2026-09-11; see git history for exact content.'),
  ('workforce-experience-delivery', 2, 'd36a5e8528e199e0af7f5e1c5272630ea10158dd', 'database/pending/workforce_delivery_fixes.sql', '04fd45148d1389e091bb8f1e17e6767b483f5e42', 'Vendored inline in supabase/migrations/20260905043052_workforce_experience_notification_delivery.sql on 2026-09-11; see git history for exact content.')
on conflict (release, ordinal) do nothing;

insert into wf_private.upgrade_snapshots(release, source_table, source_id, reason, row_data)
values (
  'workforce-experience-delivery',
  'deployment',
  'd36a5e8528e199e0af7f5e1c5272630ea10158dd',
  'Vendored source (2026-09-11): removed the runtime HTTP fetch to a since-deleted GitHub repo (laomatday/genai-erp, confirmed 404); SQL is now inlined and version-controlled. No schema/logic change versus the original 2026-09-05 apply.',
  jsonb_build_object('files', '[{"path":"workforce_delivery.sql","sha":"edf91815bc1b959cc1e32a986b9772014da41988"},{"path":"workforce_delivery_fixes.sql","sha":"04fd45148d1389e091bb8f1e17e6767b483f5e42"}]'::jsonb)
)
on conflict (release, source_table, source_id) do nothing;

notify pgrst,'reload schema';
