-- Older environments may have installed the pg_net extension object in public.
-- Its API lives in `net`, but keeping extension metadata out of public also
-- clears the Supabase Security Advisor finding. Refuse to discard operational
-- queue/history data: operators must drain or archive it before promotion.
set local lock_timeout='5s';
set local statement_timeout='120s';

create schema if not exists extensions;

do $$
declare
  extension_schema text;
  queued bigint:=0;
  responses bigint:=0;
begin
  select namespace.nspname into extension_schema
  from pg_catalog.pg_extension extension
  join pg_catalog.pg_namespace namespace on namespace.oid=extension.extnamespace
  where extension.extname='pg_net';

  if extension_schema is null then
    create extension pg_net with schema extensions;
  elsif extension_schema='public' then
    if to_regclass('net.http_request_queue') is not null then
      execute 'select count(*) from net.http_request_queue' into queued;
    end if;
    if to_regclass('net._http_response') is not null then
      execute 'select count(*) from net._http_response' into responses;
    end if;
    if queued>0 or responses>0 then
      raise exception
        'Cannot relocate pg_net: drain/archive % queued requests and % response rows first',
        queued,responses;
    end if;
    drop extension pg_net;
    create extension pg_net with schema extensions;
  elsif extension_schema<>'extensions' then
    raise exception 'pg_net is installed in unexpected schema %',extension_schema;
  end if;

  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception 'pg_net relocation did not restore net.http_post';
  end if;
end;
$$;
