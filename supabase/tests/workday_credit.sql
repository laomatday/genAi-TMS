-- The work-credit rule, one case per branch, run against the real function.
--
-- Written as a test rather than left to the migration's verify block because
-- the rule is the thing payroll is computed from, and it now has six settings
-- that an admin can change. Anyone editing those wants to know what they move.
do $test$
declare
  actual numeric;
  failures text[]:='{}';
  scenario record;
begin
  for scenario in
    select * from (values
      ('approved leave',                   false,false,0,   true, false,false, 1.0),
      ('public holiday',                   false,false,0,   false,true, false, 1.0),
      ('missing check-out, explained',     true, false,0,   false,false,true,  1.0),
      ('missing check-out, unexplained',   true, false,0,   false,false,false, 0.5),
      ('exactly eight hours',              true, true, 480, false,false,false, 1.0),
      ('one minute under eight hours',     true, true, 479, false,false,false, 0.5),
      ('exactly four hours',               true, true, 240, false,false,false, 0.5),
      ('one minute under four hours',      true, true, 239, false,false,false, 0.0),
      ('never turned up',                  false,false,0,   false,false,false, 0.0),
      -- Order matters: leave outranks a holiday, and both outrank hours worked.
      ('leave on a holiday',               false,false,0,   true, true, false, 1.0),
      ('leave despite a full day logged',  true, true, 480, true, false,false, 1.0)
    ) as t(name, has_checkin, has_checkout, minutes, on_leave, is_holiday, explained, expected)
  loop
    actual:=wf_private.workday_credit(
      scenario.has_checkin, scenario.has_checkout, scenario.minutes,
      scenario.on_leave, scenario.is_holiday, scenario.explained,
      8, 4, 1, 1, 1, 0.5
    );
    if actual is distinct from scenario.expected then
      failures:=array_append(failures, format('%s: expected %s, got %s',
        scenario.name, scenario.expected, actual));
    end if;
  end loop;

  if array_length(failures,1) is not null then
    raise exception 'workday_credit: %', array_to_string(failures, '; ');
  end if;
  raise notice 'workday_credit: all 11 cases pass';
end;
$test$;
