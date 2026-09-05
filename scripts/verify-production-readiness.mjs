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
  { pattern: /\.rpc\(['"]checkout_attendance_gps['"]/, message: 'legacy checkout_attendance_gps RPC call' },
  { pattern: /\.rpc\(['"]toggle_attendance_pause['"]/, message: 'legacy toggle_attendance_pause RPC call' },
  { pattern: /\.rpc\(['"]submit_attendance_explanation['"]/, message: 'legacy attendance explanation RPC call' },
  { pattern: /\.from\(['"]attendance_explanations['"]/, message: 'direct runtime dependency on legacy attendance_explanations table' },
  { pattern: /\.from\(['"]attendance['"]\)\s*\.update/s, message: 'direct runtime mutation of legacy attendance table' },
  { pattern: /\.eq\(['"]date['"]\s*,\s*request\.work_date/, message: 'invalid legacy attendance date-column update' },
  { pattern: /status:\s*['"]VALID['"]/, message: 'invalid canonical timesheet VALID status' },
];

for (const file of sourceFiles) {
  const content = await readFile(file, 'utf8');
  for (const rule of forbiddenRuntimePatterns) {
    if (rule.pattern.test(content)) {
      fail(`${relative(root, file)} contains ${rule.message}`);
    }
  }
}

const gitignore = await readFile(join(root, '.gitignore'), 'utf8');
for (const line of gitignore.split(/\r?\n/).map((value) => value.trim())) {
  if (line === '!.env' || (line.startsWith('!.env.') && line !== '!.env.example')) {
    fail(`.gitignore exposes runtime environment file via rule: ${line}`);
  }
}

const requiredFiles = [
  'supabase/migrations/20260906013000_production_readiness_v3.sql',
  'supabase/migrations/20260906013100_canonical_request_actions.sql',
  'supabase/migrations/20260906013200_canonical_exception_refresh.sql',
  'supabase/migrations/20260906013500_cutover_backfill_legacy_attendance.sql',
];
for (const file of requiredFiles) {
  try {
    await readFile(join(root, file), 'utf8');
  } catch {
    fail(`missing required production migration: ${file}`);
  }
}

const attendanceService = await readFile(join(root, 'src/modules/tms/services/attendance.ts'), 'utf8');
if (!attendanceService.includes("rpc('record_qr_attendance_v3'")) {
  fail('QR attendance is not routed through record_qr_attendance_v3');
}
if (!attendanceService.includes('p_device_id: getCurrentDeviceId()')) {
  fail('QR attendance does not send the verified logical device id');
}

const employeeService = await readFile(join(root, 'src/modules/tms/services/employee.ts'), 'utf8');
if (!employeeService.includes("rpc('get_my_dashboard_v3'")) {
  fail('employee dashboard is not using the canonical one-call V3 RPC');
}

if (failures.length) {
  console.error('\nProduction readiness guard failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Production readiness guard passed (${sourceFiles.length} source files checked).`);
