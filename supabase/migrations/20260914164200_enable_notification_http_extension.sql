-- Push dispatch calls net.http_post. Make the dependency part of the
-- reproducible schema instead of relying on a project-level manual toggle.
set local lock_timeout='5s';
set local statement_timeout='120s';

create schema if not exists extensions;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception 'pg_net was installed without net.http_post';
  end if;
end;
$$;
