grant insert, update on public.config_system to authenticated;

drop policy if exists admin_inserts_system_config on public.config_system;
create policy admin_inserts_system_config
  on public.config_system for insert to authenticated
  with check ((select tms_private.is_admin()));

drop policy if exists admin_updates_system_config on public.config_system;
create policy admin_updates_system_config
  on public.config_system for update to authenticated
  using ((select tms_private.is_admin()))
  with check ((select tms_private.is_admin()));

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;
