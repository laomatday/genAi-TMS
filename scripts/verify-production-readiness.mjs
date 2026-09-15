import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

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
  { pattern: /\bsupabase\s*\.\s*from\s*\(/, message: 'direct public Data API access instead of an authorized RPC' },
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
  'supabase/migrations/20260914154744_harden_commercial_tenant_boundaries.sql',
  'supabase/migrations/20260914155809_enforce_tenant_approval_roles.sql',
  'supabase/migrations/20260914161322_enforce_approval_queue_visibility.sql',
  'supabase/migrations/20260914162113_fail_closed_approval_config_validation.sql',
  'supabase/migrations/20260914162758_bound_dashboard_directory_context.sql',
  'supabase/migrations/20260914163500_require_review_capability_for_queue.sql',
  'supabase/migrations/20260914164200_enable_notification_http_extension.sql',
  'supabase/migrations/20260914164800_align_request_assignment_with_policy.sql',
  'supabase/migrations/20260914165500_enforce_sensitive_read_capabilities.sql',
  'supabase/migrations/20260914170200_freeze_safe_tenant_provisioning_templates.sql',
  'supabase/migrations/20260914171000_optimize_approval_candidate_resolution.sql',
  'supabase/migrations/20260914171600_align_direct_table_management_scope.sql',
  'supabase/migrations/20260914172200_require_login_for_request_assignee.sql',
  'supabase/migrations/20260914172800_enforce_settings_write_capability.sql',
  'supabase/migrations/20260914173000_make_request_submission_idempotent.sql',
  'supabase/migrations/20260915001000_serialize_period_sensitive_workflows.sql',
  'supabase/migrations/20260915001521_close_p0_security_surface.sql',
  'supabase/migrations/20260915001540_commercial_domain_v4_work_sessions.sql',
  'supabase/migrations/20260915002000_enforce_kiosk_capability.sql',
  'supabase/migrations/20260915002913_scale_and_commercial_workflows.sql',
  'supabase/migrations/20260915003000_relocate_pg_net_extension.sql',
  'supabase/migrations/20260915003500_enforce_final_security_state.sql',
  'supabase/tests/tenant_configuration_isolation.sql',
  'supabase/tests/attendance_session_rollover.sql',
  'supabase/tests/final_security_state.sql',
  'supabase/config.toml',
  'docs/BACKUP_RESTORE_RUNBOOK.md',
  'src/core/errors/AppErrorBoundary.tsx',
  'src/core/observability/clientTelemetry.ts',
  'src/modules/tms/utils/requestCode.ts',
  'src/modules/tms/services/workforceCapabilities.ts',
  'scripts/load-test-dashboard.mjs',
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
if (packageMetadata.scripts?.['test:load'] !== 'bun scripts/load-test-dashboard.mjs') {
  fail('staging dashboard load-test command is missing');
}
const loadScriptSyntax = spawnSync('node', ['--check', join(root, 'scripts/load-test-dashboard.mjs')], {
  encoding: 'utf8',
});
if (loadScriptSyntax.status !== 0) {
  fail(`dashboard load-test script has invalid syntax: ${loadScriptSyntax.stderr.trim()}`);
}
const loadScript = await readFile(join(root, 'scripts/load-test-dashboard.mjs'), 'utf8');
if (!loadScript.includes("/rest/v1/rpc/workforce_query")
  || !loadScript.includes("const resources = ['bootstrap', 'today']")
  || loadScript.includes('/rest/v1/rpc/tms_dashboard_bundle_v1')) {
  fail('dashboard load test must exercise the split Workforce bootstrap/today API');
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
if (!workflow.includes('supabase@2.117.0')
  || !workflow.includes('tenant_configuration_isolation.sql')
  || !workflow.includes('final_security_state.sql')) {
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
if (!attendanceService.includes('command_id: durableCommandId')
  || !attendanceService.includes('acquireAttendanceCommandId(')) {
  fail('attendance does not send an idempotency command id');
}

const employeeService = await readFile(join(root, 'src/modules/tms/services/employee.ts'), 'utf8');
if (!employeeService.includes("queryWorkforce('bootstrap'")
  || !employeeService.includes("queryWorkforce('metadata'")
  || !employeeService.includes("queryWorkforceRows('history'")
  || !employeeService.includes("queryWorkforceRows('requests'")
  || !employeeService.includes("queryWorkforceRows('directory'")) {
  fail('employee dashboard is not using the split Workforce resource APIs');
}
if (!employeeService.includes('client_request_id: input.clientRequestId') || !employeeService.includes('requestCommandId()')) {
  fail('proposal and explanation commands are missing a browser idempotency key');
}
for (const modalFile of [
  'src/modules/tms/components/ModalCreateRequest.tsx',
  'src/modules/tms/components/ModalExplainWork.tsx',
]) {
  const modalSource = await readFile(join(root, modalFile), 'utf8');
  if (!modalSource.includes('useRef(requestCommandId())') || !modalSource.includes('clientRequestIdRef.current')) {
    fail(`${modalFile} must reuse one request id across transport retries`);
  }
}

const adminUsersFunction = await readFile(join(root, 'supabase/functions/admin-users/index.ts'), 'utf8');
if (!adminUsersFunction.includes('"employee.manage"') || !adminUsersFunction.includes('CAPABILITY_DENIED')) {
  fail('admin-users Edge Function does not enforce effective employee.manage capability');
}
if (!adminUsersFunction.includes('requestedAction !== "upsert"')
  || !adminUsersFunction.includes('EMPLOYEE_RECONCILE_CONFLICT')
  || !adminUsersFunction.includes('commit_state: "AUTH_CREATED_PROFILE_PENDING"')) {
  fail('employee account import no longer exposes guarded retry/reconciliation states');
}
if (!adminUsersFunction.includes('requestedAction !== "invite"')
  || !adminUsersFunction.includes('requestedAction !== "password-reset"')
  || !adminUsersFunction.includes('inviteUserByEmail(')
  || !adminUsersFunction.includes('resetPasswordForEmail(')
  || /return\s+json\([\s\S]{0,300}(?:action_link|email_otp|hashed_token|access_token|refresh_token)/.test(adminUsersFunction)) {
  fail('admin-users invite/password recovery contract is missing or exposes an Auth credential');
}
if (!adminUsersFunction.includes('rpc("reset_trusted_device_v1"')) {
  fail('admin-users does not serialize trusted-device reset through the service-role RPC');
}
const accountsSection = await readFile(join(root, 'src/modules/tms/admin/components/AccountsSection.tsx'), 'utf8');
if (!accountsSection.includes('executeEmployeeImport(imported, saveEmployee)')
  || !accountsSection.includes('refreshOnError: (error) => error instanceof EmployeeImportError')) {
  fail('employee spreadsheet import no longer reloads authoritative data after partial failure');
}
if (accountsSection.includes("item.role === 'Admin' ? 'Miễn khóa'")) {
  fail('Control Center must not present Admin as exempt from trusted-device verification');
}
if (!constants.includes('MAX_EMPLOYEE_IMPORT_ROWS: 100')) {
  fail('interactive employee import reconciliation surface is not bounded');
}
const trustedDeviceFunction = await readFile(join(root, 'supabase/functions/trusted-device/index.ts'), 'utf8');
if (!trustedDeviceFunction.includes('"kiosk.manage"') || !trustedDeviceFunction.includes('canManageDevices')) {
  fail('trusted-device reset does not enforce effective kiosk.manage capability');
}
if (!trustedDeviceFunction.includes('rpc("activate_trusted_device_v1"')
  || !trustedDeviceFunction.includes('rpc("create_trusted_device_challenge_v1"')
  || !trustedDeviceFunction.includes('rpc("consume_trusted_device_challenge_v1"')
  || !trustedDeviceFunction.includes('rpc("reset_trusted_device_v1"')
  || trustedDeviceFunction.includes('actor.role === "Admin" ||')
  || trustedDeviceFunction.includes('.from("trusted_devices").insert(')
  || trustedDeviceFunction.includes('.from("trusted_devices").update(')
  || trustedDeviceFunction.includes('.from("trusted_device_challenges").insert(')
  || trustedDeviceFunction.includes('.from("trusted_device_challenges").update(')
  || trustedDeviceFunction.includes('.from("trusted_device_grants").upsert(')) {
  fail('trusted-device state changes must use the four atomic service-role RPCs and must not exempt Admin');
}
if (!constants.includes("DEVICE_EXEMPT_ROLES: readonly EmployeeRole[] = ['Kiosk']")) {
  fail('client trusted-device gate must exempt only the dedicated Kiosk role');
}
const trustedDeviceMigration = await readFile(
  join(root, 'supabase/migrations/20260915001540_commercial_domain_v4_work_sessions.sql'),
  'utf8',
);
for (const requiredClause of [
  'create or replace function public.activate_trusted_device_v1(',
  'create or replace function public.create_trusted_device_challenge_v1(',
  'create or replace function public.consume_trusted_device_challenge_v1(',
  'create or replace function public.reset_trusted_device_v1(',
  "'TRUSTED_DEVICE_ACTIVATED'",
  "'TRUSTED_DEVICE_RESET'",
]) {
  if (!trustedDeviceMigration.includes(requiredClause)) {
    fail(`trusted-device atomic migration missing: ${requiredClause}`);
  }
}
if ((trustedDeviceMigration.match(/'trusted-device-employee:'/g) || []).length < 4) {
  fail('all trusted-device state transitions must share the employee-level advisory lock');
}

const tmsRoutes = await readFile(join(root, 'src/modules/tms/routes.tsx'), 'utf8');
const appShell = await readFile(join(root, 'src/modules/tms/components/AppShell.tsx'), 'utf8');
const adminPortal = await readFile(join(root, 'src/modules/tms/admin/AdminPortal.tsx'), 'utf8');
const adminApp = await readFile(join(root, 'src/modules/tms/admin/AdminApp.tsx'), 'utf8');
const adminOverview = await readFile(join(root, 'src/modules/tms/admin/components/OverviewSection.tsx'), 'utf8');
const workforceCapabilities = await readFile(join(root, 'src/modules/tms/services/workforceCapabilities.ts'), 'utf8');
if (tmsRoutes.includes('ADMIN_ROUTE_ROLES')
  || !tmsRoutes.includes('hasControlCenterAccess')
  || !tmsRoutes.includes('canOpenKioskStation')) {
  fail('Control Center routes are not guarded by effective Workforce capabilities');
}
if ((tmsRoutes.match(/<DeviceGate[\s\S]{0,300}<QrStation/g) || []).length < 2) {
  fail('every QR station entry path must pass through the trusted-device gate');
}
if (!appShell.includes('hasControlCenterAccess(data.capabilities)')
  || !appShell.includes('onOpenWorkspace={canOpenControlCenter ? onOpenWorkspace : undefined}')) {
  fail('employee header exposes Control Center without dashboard effective capabilities');
}
if (!adminPortal.includes('visibleOptions')
  || !adminPortal.includes('canOpenKioskStation(user.role, capabilities)')) {
  fail('desktop workspace cards are not filtered by effective capabilities');
}
if (!adminApp.includes('allowedSections={allowedSections}')
  || !adminOverview.includes("allowedSections.has('attendance')")
  || !adminOverview.includes("allowedSections.has('scheduling')")
  || !adminOverview.includes("allowedSections.has('kiosks')")) {
  fail('Control Center overview shortcuts can reach capability-restricted sections');
}
if (!workforceCapabilities.includes("p_resource: 'bootstrap'")
  || !workforceCapabilities.includes("capabilities.includes('kiosk.manage')")) {
  fail('route capability resolver is missing the authoritative Workforce bootstrap contract');
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

const commercialBoundaryMigration = await readFile(
  join(root, 'supabase/migrations/20260914154744_harden_commercial_tenant_boundaries.sql'),
  'utf8',
);
for (const requiredClause of [
  'attendance_periods_organization_period_key',
  'on conflict(organization_id,period_start,period_end)',
  'create policy attendance_periods_read_tenant',
  'audit_logs_organization_created_idx',
  'create policy audit_logs_read_tenant',
  'attendance_policies_organization_name_key',
  'employees_organization_attendance_policy_fk',
  'timesheets_organization_policy_fk',
]) {
  if (!commercialBoundaryMigration.includes(requiredClause)) {
    fail(`commercial tenant boundary migration missing: ${requiredClause}`);
  }
}

const approvalRoleMigration = await readFile(
  join(root, 'supabase/migrations/20260914155809_enforce_tenant_approval_roles.sql'),
  'utf8',
);
for (const requiredClause of [
  'create or replace function wf_private.approval_role_allowed',
  "p_request_type in ('EXPLANATION','CORRECTION')",
  "setting.key='APPROVAL_ROLES'",
  'create trigger attendance_requests_enforce_approval_role',
]) {
  if (!approvalRoleMigration.includes(requiredClause)) {
    fail(`approval role migration missing: ${requiredClause}`);
  }
}

const approvalVisibilityMigration = await readFile(
  join(root, 'supabase/migrations/20260914161322_enforce_approval_queue_visibility.sql'),
  'utf8',
);
for (const requiredClause of [
  'create policy attendance_requests_read_scoped',
  'wf_private.approval_role_allowed(r.organization_id,r.request_type)',
  'config_system_validate_approval_roles',
  'metadata->>\'organization_id\'=a.organization_id::text',
  "values(new.id,'Chuẩn văn phòng')",
]) {
  if (!approvalVisibilityMigration.includes(requiredClause)) {
    fail(`approval queue visibility migration missing: ${requiredClause}`);
  }
}

const approvalValidationMigration = await readFile(
  join(root, 'supabase/migrations/20260914162113_fail_closed_approval_config_validation.sql'),
  'utf8',
);
for (const requiredClause of [
  "jsonb_typeof(config->'leave') is distinct from 'array'",
  "jsonb_typeof(config->'attendance') is distinct from 'array'",
  'create or replace function wf_private.validate_approval_roles_configuration',
]) {
  if (!approvalValidationMigration.includes(requiredClause)) {
    fail(`approval configuration validation migration missing: ${requiredClause}`);
  }
}

const boundedDirectoryMigration = await readFile(
  join(root, 'supabase/migrations/20260914162758_bound_dashboard_directory_context.sql'),
  'utf8',
);
for (const requiredClause of [
  'create or replace function public.tms_directory_context_v1()',
  "employee.status='Active'",
  'limit 100',
  "wf_private.capable('directory.read')",
]) {
  if (!boundedDirectoryMigration.includes(requiredClause)) {
    fail(`bounded dashboard directory migration missing: ${requiredClause}`);
  }
}

const reviewCapabilityMigration = await readFile(
  join(root, 'supabase/migrations/20260914163500_require_review_capability_for_queue.sql'),
  'utf8',
);
for (const requiredClause of [
  'create or replace function wf_private.approval_role_allowed',
  "not wf_private.capable('attendance.review')",
  "jsonb_typeof(config->'leave') is distinct from 'array'",
]) {
  if (!reviewCapabilityMigration.includes(requiredClause)) {
    fail(`review capability migration missing: ${requiredClause}`);
  }
}

const notificationHttpMigration = await readFile(
  join(root, 'supabase/migrations/20260914164200_enable_notification_http_extension.sql'),
  'utf8',
);
for (const requiredClause of [
  'create extension if not exists pg_net',
  'with schema extensions',
  "to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)')",
]) {
  if (!notificationHttpMigration.includes(requiredClause)) {
    fail(`notification HTTP dependency migration missing: ${requiredClause}`);
  }
}

const notificationHttpRelocationMigration = await readFile(
  join(root, 'supabase/migrations/20260915003000_relocate_pg_net_extension.sql'),
  'utf8',
);
for (const requiredClause of [
  "extension_schema='public'",
  "to_regclass('net.http_request_queue')",
  "to_regclass('net._http_response')",
  'create extension pg_net with schema extensions',
]) {
  if (!notificationHttpRelocationMigration.includes(requiredClause)) {
    fail(`notification HTTP relocation migration missing: ${requiredClause}`);
  }
}

const commercialWorkflowMigration = await readFile(
  join(root, 'supabase/migrations/20260915002913_scale_and_commercial_workflows.sql'),
  'utf8',
);
if (commercialWorkflowMigration.includes('manifest=privacy_command.manifest')
  || commercialWorkflowMigration.includes('manager_note=reason')) {
  fail('commercial workflow migration contains ambiguous PL/pgSQL variable references');
}
if (!commercialWorkflowMigration.includes('manifest=export_manifest')
  || !commercialWorkflowMigration.includes('manager_note=review_reason')) {
  fail('commercial workflow migration must use unambiguous DSAR/review local variables');
}
if (!commercialWorkflowMigration.includes('and employee.employee_id=request.assigned_to')) {
  fail('commercial workflow backfill must preserve an eligible legacy first-step assignee');
}

const requestAssignmentMigration = await readFile(
  join(root, 'supabase/migrations/20260914164800_align_request_assignment_with_policy.sql'),
  'utf8',
);
for (const requiredClause of [
  'create or replace function wf_private.employee_capable',
  'create or replace function wf_private.employee_approval_eligible',
  "employee_capable(actor_organization,actor_employee_id,'team.read')",
  'Chưa có người duyệt phù hợp với chính sách của tổ chức.',
  'Could not safely patch request escalation routing',
]) {
  if (!requestAssignmentMigration.includes(requiredClause)) {
    fail(`request assignment policy migration missing: ${requiredClause}`);
  }
}

const sensitiveReadMigration = await readFile(
  join(root, 'supabase/migrations/20260914165500_enforce_sensitive_read_capabilities.sql'),
  'utf8',
);
for (const requiredClause of [
  'create or replace function tms_private.can_manage_employee',
  "employee_capable(a.organization_id,a.employee_id,'team.read')",
  'create or replace function tms_private.can_view_audit()',
  'and (select tms_private.can_view_audit())',
]) {
  if (!sensitiveReadMigration.includes(requiredClause)) {
    fail(`sensitive read capability migration missing: ${requiredClause}`);
  }
}

const tenantTemplateMigration = await readFile(
  join(root, 'supabase/migrations/20260914170200_freeze_safe_tenant_provisioning_templates.sql'),
  'utf8',
);
for (const requiredClause of [
  'create table if not exists wf_private.tenant_capability_templates',
  'select role,capability,enabled',
  'APPROVAL_ROLES sai cấu trúc ở tổ chức %',
  'from wf_private.tenant_system_templates',
  'organization_id,role,capability,enabled',
]) {
  if (!tenantTemplateMigration.includes(requiredClause)) {
    fail(`tenant provisioning template migration missing: ${requiredClause}`);
  }
}

const approvalCandidateMigration = await readFile(
  join(root, 'supabase/migrations/20260914171000_optimize_approval_candidate_resolution.sql'),
  'utf8',
);
for (const requiredClause of [
  'employees_active_approval_candidates_idx',
  "role in ('Leader','Manager','Director','HR','Admin')",
  'Could not safely optimize escalation candidates',
]) {
  if (!approvalCandidateMigration.includes(requiredClause)) {
    fail(`approval candidate optimization migration missing: ${requiredClause}`);
  }
}

const managementScopeMigration = await readFile(
  join(root, 'supabase/migrations/20260914171600_align_direct_table_management_scope.sql'),
  'utf8',
);
for (const requiredClause of [
  'create or replace function tms_private.can_manage_employee',
  "employee_capable(a.organization_id,a.employee_id,'team.read_all')",
  'or t.direct_manager_id=a.employee_id',
]) {
  if (!managementScopeMigration.includes(requiredClause)) {
    fail(`direct-table management scope migration missing: ${requiredClause}`);
  }
}

const assigneeLoginMigration = await readFile(
  join(root, 'supabase/migrations/20260914172200_require_login_for_request_assignee.sql'),
  'utf8',
);
if (!assigneeLoginMigration.includes('or candidate.auth_user_id is null')) {
  fail('request assignee eligibility does not require a usable Auth identity');
}

const settingsWriteMigration = await readFile(
  join(root, 'supabase/migrations/20260914172800_enforce_settings_write_capability.sql'),
  'utf8',
);
for (const requiredClause of [
  'create or replace function tms_private.can_manage_settings',
  "'settings.manage'",
  'create policy config_shifts_insert_settings_capability',
  'create policy config_system_insert_settings_capability',
  'create policy holidays_insert_settings_capability',
  'create policy locations_insert_settings_capability',
  'create policy attendance_policies_insert_settings_capability',
]) {
  if (!settingsWriteMigration.includes(requiredClause)) {
    fail(`settings write capability migration missing: ${requiredClause}`);
  }
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

const requestIdempotencyMigration = await readFile(
  join(root, 'supabase/migrations/20260914173000_make_request_submission_idempotent.sql'),
  'utf8',
);
for (const requiredClause of [
  'attendance_requests_client_request_id_key',
  'pg_advisory_xact_lock',
  'client_request_id=client_id',
  "'replayed',true",
]) {
  if (!requestIdempotencyMigration.includes(requiredClause)) {
    fail(`request idempotency migration missing: ${requiredClause}`);
  }
}

const periodSerializationMigration = await readFile(
  join(root, 'supabase/migrations/20260915001000_serialize_period_sensitive_workflows.sql'),
  'utf8',
);
for (const requiredClause of [
  'period_lock(a.organization_id,day,day,false)',
  'period_lock(a.organization_id,first_day,last_day,false)',
  'period_lock(a.organization_id,r.from_date,r.to_date,false)',
  'where id=sheet.id and organization_id=a.organization_id',
  'Active attendance lock order must be lookup/period/CLOSED/timesheet',
  'Request replay/period-lock/CLOSED ordering is invalid',
]) {
  if (!periodSerializationMigration.includes(requiredClause)) {
    fail(`period-sensitive workflow serialization migration missing: ${requiredClause}`);
  }
}

const kioskCapabilityMigration = await readFile(
  join(root, 'supabase/migrations/20260915002000_enforce_kiosk_capability.sql'),
  'utf8',
);
for (const requiredClause of [
  "actor.role <> 'Kiosk'",
  'wf_private.employee_capable(',
  "'kiosk.manage'",
  "using errcode = '42501'",
  'Could not safely patch create_attendance_qr_v1 authorization',
]) {
  if (!kioskCapabilityMigration.includes(requiredClause)) {
    fail(`kiosk capability migration missing: ${requiredClause}`);
  }
}

const p0SecurityMigration = await readFile(
  join(root, 'supabase/migrations/20260915001521_close_p0_security_surface.sql'),
  'utf8',
);
for (const requiredClause of [
  'revoke all on all tables in schema public',
  'revoke all on all functions in schema tms_private',
  'Authenticated users receive no direct public',
  'graphql_public is owned by the managed supabase_admin role',
  'service_role must not provision organizations',
  'drop policy if exists avatar_owner_select on storage.objects',
  'drop policy if exists avatar_owner_insert on storage.objects',
  'drop policy if exists avatar_owner_update on storage.objects',
  'drop policy if exists avatar_owner_delete on storage.objects',
  'create trigger audit_logs_append_only',
  'before update or delete or truncate on public.audit_logs',
  'create or replace function tms_private.directory_context_v1()',
  'security invoker',
]) {
  if (!p0SecurityMigration.includes(requiredClause)) {
    fail(`P0 final security migration missing: ${requiredClause}`);
  }
}
if (p0SecurityMigration.includes('drop policy %I on storage.objects')) {
  fail('P0 migration must not drop Storage policies owned by other buckets');
}

const finalSecurityTest = await readFile(
  join(root, 'supabase/tests/final_security_state.sql'),
  'utf8',
);
for (const requiredClause of [
  'Every public table must have RLS enabled',
  'Dedicated customer project contains multiple organizations',
  'Shared-project service-role onboarding is still possible',
  'Audit TRUNCATE was not blocked',
  'Workflow decision TRUNCATE was not blocked',
  'Avatar owner policy matrix is incomplete',
  'Policies for other buckets may coexist on storage.objects',
  'RPC-only authenticated role unexpectedly has',
  'Unexpected anon execute on private function',
  'A permissive API-role default ACL remains',
]) {
  if (!finalSecurityTest.includes(requiredClause)) {
    fail(`final security-state test missing: ${requiredClause}`);
  }
}

const finalSecuritySeal = await readFile(
  join(root, 'supabase/migrations/20260915003500_enforce_final_security_state.sql'),
  'utf8',
);
for (const requiredClause of [
  'revoke all on all tables in schema public',
  'revoke all on all functions in schema tms_private, wf_private',
  'create or replace function public.workforce_query(',
  'create or replace function public.workforce_command(',
  'security definer',
  'authenticated must remain RPC-only',
  'before update or delete or truncate on public.audit_logs',
  'before update or delete or truncate on public.workflow_decisions',
]) {
  if (!finalSecuritySeal.includes(requiredClause)) {
    fail(`final security seal migration missing: ${requiredClause}`);
  }
}

const tenantIsolationTest = await readFile(
  join(root, 'supabase/tests/tenant_configuration_isolation.sql'),
  'utf8',
);
for (const requiredClause of [
  "'TENANT-A-ADMIN','kiosk.manage',false",
  "'TENANT-A-MANAGER','kiosk.manage',true",
  "public.create_attendance_qr('TENANT-A-SETTINGS')",
  'Dedicated Kiosk account could not create QR',
]) {
  if (!tenantIsolationTest.includes(requiredClause)) {
    fail(`tenant QR authorization regression test missing: ${requiredClause}`);
  }
}

const supabaseConfig = await readFile(join(root, 'supabase/config.toml'), 'utf8');
if (!supabaseConfig.includes('auto_expose_new_tables = false')) {
  fail('new public tables must not be automatically exposed through the Data API');
}
if (!supabaseConfig.includes('schemas = ["public"]')) {
  fail('unused graphql_public schema must not be exposed through the Data API');
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
