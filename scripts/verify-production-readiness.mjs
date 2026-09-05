import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const failures = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(fullPath));
    else files.push(fullPath);
  }
  return files;
}

function fail(message) {
  failures.push(message);
}

const sourceFiles = (await walk(join(root, 'src')))
  .filter((file) => ['.ts', '.tsx'].includes(extname(file)));

const forbiddenRuntimePatterns = [
  { pattern: /\.rpc\(['"]record_qr_attendance['"]/, message: 'legacy record_qr_attendance RPC call' },
  { pattern: /\.rpc\(['"]record_qr_attendance_v2['"]/, message: 'legacy record_qr_attendance_v2 RPC call' },
  { pattern: /\.rpc\(['"]record_qr_attendance_v3['"]/, message: 'duplicate custom V3 attendance RPC instead of Workforce command API' },
  { pattern: /\.rpc\(['"]checkout_attendance_gps(?:_v3)?['"]/, message: 'legacy/custom checkout RPC call' },
  { pattern: /\.rpc\(['"]toggle_attendance_pause(?:_v3)?['"]/, message: 'legacy/custom pause RPC call' },
  { pattern: /\.rpc\(['"]submit_attendance_explanation(?:_v3)?['"]/, message: 'legacy/custom attendance explanation RPC call' },
  { pattern: /\.rpc\(['"]get_my_(?:attendance|dashboard_v3|tms_v2)['"]/, message: 'legacy/custom dashboard RPC call' },
  { pattern: /\.from\(['"]attendance_explanations['"]/, message: 'direct runtime dependency on legacy attendance_explanations table' },
  { pattern: /\.from\(['"]attendance['"]\)\s*\.update/s, message: 'direct runtime mutation of legacy attendance table' },
  { pattern: /\.eq\(['"]date['"]\s*,\s*request\.work_date/, message: 'invalid legacy attendance date-column update' },
  { pattern: /status:\s*['"]VALID['"]/, message: 'invalid canonical timesheet VALID status' },
];

for (const file of sourceFiles) {
  const content = await readFile(file, 'utf8');
  for (const rule of forbiddenRuntimePatterns) {
    if (rule.pattern.test(content)) fail(`${relative(root, file)} contains ${rule.message}`);
  }
}

const gitignore = await readFile(join(root, '.gitignore'), 'utf8');
for (const line of gitignore.split(/\r?\n/).map((value) => value.trim())) {
  if (line === '!.env' || (line.startsWith('!.env.') && line !== '!.env.example')) {
    fail(`.gitignore exposes runtime environment file via rule: ${line}`);
  }
}

const requiredFiles = [
  'supabase/migrations/20260905032637_deploy_workforce_v3_verified_release.sql',
  'supabase/migrations/20260905032823_fix_workforce_v3_query_dates_and_aliases.sql',
  'supabase/migrations/20260905033401_harden_workforce_v3_published_schedule_and_review.sql',
  'supabase/migrations/20260905043052_workforce_experience_notification_delivery.sql',
  'supabase/migrations/20260905043727_workforce_enable_scheduled_maintenance.sql',
  'supabase/migrations/20260906070000_tms_workforce_v3_hardening.sql',
];
for (const file of requiredFiles) {
  try {
    await readFile(join(root, file), 'utf8');
  } catch {
    fail(`missing required production migration: ${file}`);
  }
}

const attendanceService = await readFile(join(root, 'src/modules/tms/services/attendance.ts'), 'utf8');
if (!attendanceService.includes("rpc('workforce_command'")) {
  fail('attendance is not routed through workforce_command');
}
if (!attendanceService.includes("p_action: 'attendance'")) {
  fail('attendance does not use the Workforce attendance action');
}
if (!attendanceService.includes('device_id: getCurrentDeviceId()')) {
  fail('attendance does not send the verified logical device id');
}
if (!attendanceService.includes('command_id: commandId()')) {
  fail('attendance does not send an idempotency command id');
}

const employeeService = await readFile(join(root, 'src/modules/tms/services/employee.ts'), 'utf8');
if (!employeeService.includes("rpc('tms_dashboard_bundle_v1'")) {
  fail('employee dashboard is not using the one-roundtrip Workforce V3 bundle');
}
if (!employeeService.includes("p_action: 'request.submit'")) {
  fail('employee requests are not routed through Workforce V3');
}

const hardeningMigration = await readFile(join(root, 'supabase/migrations/20260906070000_tms_workforce_v3_hardening.sql'), 'utf8');
for (const requiredClause of [
  't.organization_id = a.organization_id',
  'revoke all on function public.record_qr_attendance(',
  'create or replace function public.tms_dashboard_bundle_v1',
]) {
  if (!hardeningMigration.includes(requiredClause)) fail(`hardening migration missing: ${requiredClause}`);
}

if (failures.length) {
  console.error('\nProduction readiness guard failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Production readiness guard passed (${sourceFiles.length} source files checked).`);
