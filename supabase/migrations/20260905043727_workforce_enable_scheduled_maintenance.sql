-- Only local database maintenance/in-app reminders are enabled here.
-- The Web Push Edge Function was not deployed; no push job or secret is created.
do $activation$
begin
 if not exists(select 1 from pg_available_extensions where name='pg_cron') then
  raise notice 'pg_cron is unavailable in this isolated environment; validate the worker with SQL tests instead.';
  return;
 end if;
 if to_regprocedure('wf_private.run_automation()') is null then raise exception 'Maintenance worker is not installed';end if;
 execute 'create extension if not exists pg_cron';
 perform cron.schedule('genai-workforce-maintenance','*/5 * * * *','SELECT wf_private.run_automation();');
 update wf_private.delivery_config set maintenance_enabled=true where singleton;
end $activation$;