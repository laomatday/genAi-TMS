import process from 'node:process';
import { createInterface } from 'node:readline/promises';

// Creates one dedicated Kiosk account per branch. A Kiosk account only displays
// the rotating QR code: it never self-attends, and it is exempt from the trusted
// device flow because the hardware is shared by everyone at the branch.
//
// The script is additive and idempotent by employee code: a branch that already
// has its kiosk account is reported and skipped rather than rewritten, so a
// re-run after a partial failure reconciles instead of resetting passwords.

function help() {
  console.log(`Usage: bun scripts/provision-kiosk-accounts.mjs [--apply]

Reads every active branch and creates the missing Kiosk account for each one.

Required environment:
  TMS_ADMIN_URL              Supabase project URL
  TMS_ADMIN_SERVICE_KEY      Service-role key (never a VITE_* variable)

Optional environment:
  TMS_ADMIN_BRAND            Password suffix (default genAi -> "@genai")
  TMS_ADMIN_EMAIL_DOMAIN     Login domain (default genai.ai.vn)

Without --apply the script only prints the plan. With --apply it asks you to
type the project hostname before writing. Credentials are never printed.`);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  help();
  process.exit(0);
}

const APPLY = process.argv.includes('--apply');
const MIN_PASSWORD_LENGTH = 8;

function requireValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function brandSlug(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Kiosk credentials are keyed on the branch code rather than the employee-name
 *  rule used for people: the operator on duty reads this off a sticker next to a
 *  shared screen, so `kioskanb@genai` is both guessable-by-design and typeable. */
function kioskPassword(centerId, brand) {
  return `kiosk${brandSlug(centerId)}@${brandSlug(brand)}`;
}

async function rest(baseUrl, serviceKey, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method || 'GET'} ${path} failed with ${response.status}: ${body.slice(0, 300)}`);
  }
  return body ? JSON.parse(body) : null;
}

async function main() {
  const url = requireValue('TMS_ADMIN_URL').replace(/\/+$/, '');
  const serviceKey = requireValue('TMS_ADMIN_SERVICE_KEY');
  const brand = process.env.TMS_ADMIN_BRAND?.trim() || 'genAi';
  const emailDomain = process.env.TMS_ADMIN_EMAIL_DOMAIN?.trim() || 'genai.ai.vn';
  const hostname = new URL(url).hostname;

  const locations = await rest(
    url,
    serviceKey,
    '/rest/v1/locations?select=center_id,center_name,organization_id,active&active=eq.true&order=center_id',
  );
  const existing = await rest(
    url,
    serviceKey,
    '/rest/v1/employees?select=employee_id,name,email,center_id,role&role=eq.Kiosk',
  );
  const coveredCenters = new Set(existing.map((row) => row.center_id));

  const planned = [];
  const skipped = [];
  for (const location of locations) {
    if (coveredCenters.has(location.center_id)) {
      const owner = existing.find((row) => row.center_id === location.center_id);
      skipped.push({ centerId: location.center_id, reason: `đã có kiosk ${owner?.employee_id}` });
      continue;
    }
    const password = kioskPassword(location.center_id, brand);
    if (password.length < MIN_PASSWORD_LENGTH) {
      skipped.push({ centerId: location.center_id, reason: 'mật khẩu sinh ra quá ngắn' });
      continue;
    }
    planned.push({
      employeeId: `KIOSK-${location.center_id}`,
      name: `Kiosk ${location.center_name}`,
      email: `kiosk-${location.center_id.toLowerCase()}@${emailDomain}`,
      centerId: location.center_id,
      organizationId: location.organization_id,
      password,
    });
  }

  console.log(`Project  : ${hostname}`);
  console.log(`Branches : ${locations.length} active`);
  console.log(`To create: ${planned.length}`);
  console.log(`Skipped  : ${skipped.length}`);
  for (const entry of skipped) console.log(`  - ${entry.centerId}: ${entry.reason}`);
  console.log('');
  for (const entry of planned) {
    console.log(`  ${entry.employeeId.padEnd(14)} ${entry.email.padEnd(32)} ${entry.password}`);
  }

  if (!APPLY) {
    console.log('\nPlan only. Re-run with --apply to create these accounts.');
    return;
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const confirmation = await prompt.question(`\nType "${hostname}" to create ${planned.length} kiosk accounts: `);
  prompt.close();
  if (confirmation.trim() !== hostname) {
    throw new Error('Hostname did not match. Nothing was created.');
  }

  let created = 0;
  const failures = [];
  for (const entry of planned) {
    let authUserId = null;
    try {
      const authUser = await rest(url, serviceKey, '/auth/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          email: entry.email,
          password: entry.password,
          email_confirm: true,
          user_metadata: { name: entry.name },
          app_metadata: { app_role: 'Kiosk', organization_id: entry.organizationId },
        }),
      });
      authUserId = authUser?.id || null;
      if (!authUserId) throw new Error('Auth did not return a user id.');

      await rest(url, serviceKey, '/rest/v1/employees', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          employee_id: entry.employeeId,
          organization_id: entry.organizationId,
          auth_user_id: authUserId,
          name: entry.name,
          email: entry.email,
          role: 'Kiosk',
          center_id: entry.centerId,
          allowed_locations: [entry.centerId],
          managed_locations: [],
          // A kiosk never files or accrues anything; it only renders the QR.
          attendance_policy_id: null,
          annual_leave_balance: 0,
          status: 'Active',
        }),
      });
      created += 1;
    } catch (error) {
      // Auth and Postgres are separate systems. If the profile insert failed the
      // orphaned login is removed, otherwise a re-run would collide on the email
      // without ever producing a usable account.
      if (authUserId) {
        try {
          await rest(url, serviceKey, `/auth/v1/admin/users/${authUserId}`, { method: 'DELETE' });
        } catch (rollbackError) {
          failures.push({ centerId: entry.centerId, message: `${error.message} — và không gỡ được tài khoản Auth thừa: ${rollbackError.message}` });
          continue;
        }
      }
      failures.push({ centerId: entry.centerId, message: error.message });
    }
  }

  console.log(`\nCreated ${created}/${planned.length} kiosk accounts.`);
  for (const failure of failures) console.error(`  ! ${failure.centerId}: ${failure.message}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
