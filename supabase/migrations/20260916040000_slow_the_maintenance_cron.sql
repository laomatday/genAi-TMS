-- The maintenance batch ran every five minutes and accounted for 19.4% of all
-- database CPU — 874 seconds against the application's 2,425 — on an instance
-- with roughly a tenth of a core to spend.
--
-- Most of that work achieves nothing. Of 44 jobs in the queue, 26 have failed
-- and between them carry 323 attempts, against 18 successes that each took one.
-- The failures are deterministic (see 20260916050000), so every retry is spent
-- reaching the same error again.
--
-- Fifteen minutes is enough for what this job actually does: create the
-- placeholder sessions for a day and raise MISSING_CHECKIN once a check-in
-- window has closed. Neither is minute-sensitive, and nothing an employee does
-- waits on it — attendance writes its own rows.

do $migration$
declare
  current_schedule text;
begin
  select schedule into current_schedule from cron.job where jobid = 1;
  if current_schedule is null then
    raise exception 'maintenance cron job is missing';
  end if;
  if current_schedule <> '*/5 * * * *' then
    raise notice 'maintenance cron already on %, leaving it alone', current_schedule;
    return;
  end if;
  perform cron.alter_job(job_id => 1, schedule => '*/15 * * * *');
  raise notice 'maintenance cron moved from every 5 minutes to every 15';
end;
$migration$;

do $verify$
begin
  if (select schedule from cron.job where jobid = 1) <> '*/15 * * * *' then
    raise exception 'maintenance cron did not take the new schedule';
  end if;
end;
$verify$;
