-- Synchronize the production migration history after the admin CRUD audit.
-- config_shifts.id already owns this identity sequence, so this is intentionally idempotent.

create sequence if not exists public.config_shifts_id_seq;
