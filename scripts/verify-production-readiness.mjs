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
  { pattern: /\.rpc\(['"]close_attendance_period_v1['"]/, message: 'legacy close_attendance_period_v1 RPC call' },
  { pattern: /\.rpc\(['"]lock_timesheets_v2['"]/, message: 'legacy lock_timesheets_v2 RPC call' },
  { pattern: /\.rpc\(['"]get_employee_directory['"]/, message: 'legacy get_employee_directory RPC call' },
  { pattern: /\.rpc\(['"]save_shift_assignments_v1['"]/, message: 'legacy save_shift_assignments_v1 RPC call' },
  { pattern: /\.rpc\(['"]refresh_tms_exceptions_v2['"]/, message: 'legacy refresh_tms_exceptions_v2 RPC call' },
  { pattern: /\.rpc\(['"]delete_shift_assignment_v1['"]/, message: 'legacy delete_shift_assignment_v1 RPC call' },
  { pattern: /\.rpc\(['"]review_attendance_request_v2['"]/, message: 'legacy review_attendance_request_v2 RPC call' },
  { pattern: /\.rpc\(['"]review_leave_request['"]/, message: 'legacy review_leave_request RPC call' },
  { pattern: /\.rpc\(['"]submit_attendance_request_v2['"]/, message: 'legacy submit_attendance_request_v2 RPC call' },
  { pattern: /\.rpc\(['"]submit_leave_request['"]/, message: 'legacy submit_leave_request RPC call' },
  { pattern: /\.from\(['"]attendance_explanations['"]/, message: 'direct runtime dependency on legacy attendance_explanations table' },
  { pattern: /\.from\(['"]attendance['"]\)\s*\.update/s, message: 'direct runtime mutation of legacy attendance table' },
  { pattern: /\.eq\(['"]date['"]\s*,\s*request\.work_date/, message: 'invalid legacy attendance date-column update' },
  { pattern: /status:\s*['"]VALID['"]/, message: 'invalid canonical timesheet VALID status' },
  { pattern: /\.slice\(\s*-\s*8\s*\)/, message: 'UUID fragment used as a display identifier' },
  {
    pattern: /\b(?:useHorizontalSwipe|useModalSwipeBack|useModalTabSwipe|RegisterSwipeHandler)\b|data-swipe-(?:surface|phase)/,
    message: 'removed horizontal gesture navigation',
  },
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
  'supabase/migrations/20260906003619_tms_workforce_v3_hardening.sql',
  'supabase/migrations/20260907015350_retire_workforce_v3_legacy_rpc_compatibility.sql',
  'supabase/migrations/20260912033556_branch_directory_context.sql',
  'supabase/migrations/20260914102118_tenantize_workforce_configuration.sql',
  'supabase/migrations/20260914114002_allow_checkin_with_stale_sessions.sql',
  'supabase/tests/tenant_configuration_isolation.sql',
  'supabase/tests/attendance_session_rollover.sql',
  'supabase/config.toml',
  'src/core/errors/AppErrorBoundary.tsx',
  'src/core/observability/clientTelemetry.ts',
  'src/modules/tms/utils/requestCode.ts',
];
for (const file of requiredFiles) {
  try {
    await readFile(join(root, file), 'utf8');
  } catch {
    fail(`missing required production migration: ${file}`);
  }
}

const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (packageMetadata.packageManager !== 'bun@1.4.2') {
  fail('package manager must stay pinned for reproducible commercial builds');
}
if (packageMetadata.engines?.node !== '>=22') {
  fail('Node.js production runtime contract is missing or has changed');
}
if (!packageMetadata.scripts?.['check:release']?.includes('audit:dependencies')) {
  fail('release verification does not include a dependency vulnerability audit');
}

const mainEntry = await readFile(join(root, 'src/main.tsx'), 'utf8');
if (!mainEntry.includes('<AppErrorBoundary>') || !mainEntry.includes('installGlobalErrorReporting()')) {
  fail('global render recovery and client error reporting must remain installed');
}

const constants = await readFile(join(root, 'src/shared/constants/index.ts'), 'utf8');
if (constants.includes("VERSION: '2.1.0'") || !constants.includes('__APP_VERSION__')) {
  fail('application version must come from build metadata rather than a hardcoded display value');
}

const workflow = await readFile(join(root, '.github/workflows/build.yml'), 'utf8');
if (!workflow.includes('bun-version: 1.4.2') || !workflow.includes('bun run check:release')) {
  fail('commercial CI gates are missing or use an unpinned toolchain');
}
if (!workflow.includes('supabase@2.117.0') || !workflow.includes('tenant_configuration_isolation.sql')) {
  fail('tenant database isolation is not enforced in CI with a pinned Supabase CLI');
}

const indexDocument = await readFile(join(root, 'index.html'), 'utf8');
if (/<script(?![^>]+src=)[^>]*>/i.test(indexDocument)) {
  fail('index.html contains an inline script that production CSP will block');
}

const viteConfig = await readFile(join(root, 'vite.config.ts'), 'utf8');
if (viteConfig.includes('allowedHosts: true') || !viteConfig.includes('strictPort: true')) {
  fail('development server must reject arbitrary hostnames and port drift');
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

const contactsPage = await readFile(join(root, 'src/modules/tms/pages/Contacts.tsx'), 'utf8');
if (contactsPage.includes('localStorage') || constants.includes('CONTACTS_CACHE')) {
  fail('employee directory data must not be persisted in browser localStorage');
}
if (!employeeService.includes("p_action: 'request.submit'")) {
  fail('employee requests are not routed through Workforce V3');
}

const hardeningMigration = await readFile(join(root, 'supabase/migrations/20260906003619_tms_workforce_v3_hardening.sql'), 'utf8');
for (const requiredClause of [
  't.organization_id = a.organization_id',
  'create or replace function tms_private.request_organization()',
  'create policy employees_update_admin_scope_v3',
  'create policy locations_update_admin_scope_v3',
  'create policy attendance_policies_read_scope_v3',
  'create policy qr_stations_read_scope_v3',
  'create or replace function tms_private.create_attendance_qr_v1',
  'create or replace function tms_private.update_qr_station_admin_v1',
  'create or replace function tms_private.set_my_avatar_v1',
  'create or replace function public.tms_dashboard_bundle_v1',
  'revoke all on function public.close_attendance_period_v1',
  'revoke all on function public.get_employee_directory()',
]) {
  if (!hardeningMigration.includes(requiredClause)) fail(`hardening migration missing: ${requiredClause}`);
}
if (/^\s*begin\s*;/mi.test(hardeningMigration) || /^\s*commit\s*;/mi.test(hardeningMigration)) {
  fail('hardening migration must not own the outer transaction; apply_migration should own it');
}

const tenantMigration = await readFile(
  join(root, 'supabase/migrations/20260914102118_tenantize_workforce_configuration.sql'),
  'utf8',
);
for (const requiredClause of [
  'config_shifts_organization_name_key unique (organization_id, name)',
  'config_system_pkey primary key (organization_id, key)',
  'holidays_organization_dates_idx',
  'shift_assignments_organization_shift_fk',
  'workforce_staffing_rules_organization_shift_fk',
  'create policy config_shifts_read_tenant',
  'create policy config_system_read_tenant',
  'create policy holidays_read_tenant',
  'create table public.workforce_request_counters',
  'attendance_requests_organization_request_code_key',
  'create or replace function wf_private.seed_organization_configuration()',
]) {
  if (!tenantMigration.includes(requiredClause)) fail(`tenant migration missing: ${requiredClause}`);
}

const attendanceRolloverMigration = await readFile(
  join(root, 'supabase/migrations/20260914114002_allow_checkin_with_stale_sessions.sql'),
  'utf8',
);
for (const requiredClause of [
  'SUPERSEDED_BY_NEW_CHECKIN',
  "work_date=day",
  'TIMESHEET_EXPLANATION_APPROVED',
  "source='ADJUSTED'",
  'timesheets_employee_unfinished_idx',
]) {
  if (!attendanceRolloverMigration.includes(requiredClause)) fail(`attendance rollover migration missing: ${requiredClause}`);
}

const supabaseConfig = await readFile(join(root, 'supabase/config.toml'), 'utf8');
if (!supabaseConfig.includes('auto_expose_new_tables = false')) {
  fail('new public tables must not be automatically exposed through the Data API');
}

const requestCodeUtility = await readFile(join(root, 'src/modules/tms/utils/requestCode.ts'), 'utf8');
if (!requestCodeUtility.includes('REQUEST_CODE_PATTERN') || !requestCodeUtility.includes('request_code')) {
  fail('user-facing request codes must come from validated tenant business references');
}

if (failures.length) {
  console.error('\nProduction readiness guard failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Production readiness guard passed (${sourceFiles.length} source files checked).`);
