import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { readFileSync, statSync } from 'node:fs';

// One-off provisioning tool: rewrites every existing account to the name-derived
// default password and re-arms the "change your password" reminder.
//
// This is destructive and cannot be undone — the previous passwords are hashed
// and unrecoverable, and everyone must sign in again with the default. It plans
// by default and only writes when --apply is passed and the project hostname is
// typed back, so it can never be run by accident from shell history.

function help() {
  console.log(`Usage: bun scripts/reset-default-passwords.mjs [--apply]

Rewrites every employee's Supabase Auth password to the default derived from
their name (Cao Văn Trọng Nghĩa -> cvtnghia@genai) and sets
employees.password_change_required so the app prompts them to replace it.

Required environment:
  TMS_ADMIN_URL              Supabase project URL
  TMS_ADMIN_SERVICE_KEY      Service-role key (never a VITE_* variable)

Optional environment:
  TMS_ADMIN_BRAND            Password suffix (default genAi -> "@genai")
  TMS_ADMIN_SKIP_EMAILS      Extra comma-separated emails to leave untouched

Without --apply the script only prints the plan. With --apply it asks you to
type the project hostname before writing. Credentials are never printed.`);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  help();
  process.exit(0);
}

const APPLY = process.argv.includes('--apply');

// Accounts that must keep the password they already have.
const ALWAYS_SKIP_EMAILS = ['nghiacvt81@gmail.com'];

/** The project URL is not a secret — it ships in the browser bundle — so reading
 *  it from .env.local saves the operator retyping it and removes a chance of
 *  aiming at the wrong project. Typing the hostname back still guards the target.
 */
function readEnvFile(name, variable) {
  try {
    const file = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
    const match = new RegExp(`^\\s*${variable}\\s*=\\s*"?([^"\\r\\n]+)"?`, 'm').exec(file);
    return { value: match?.[1]?.trim() || '', mode: statSync(new URL(`../${name}`, import.meta.url)).mode };
  } catch {
    return { value: '', mode: 0 };
  }
}

/** The service key may also live in .env.admin.local, which .gitignore already
 *  covers. Keeping it out of the shell entirely is the point: an operator who has
 *  to assemble a one-off env var for every run eventually pastes the key
 *  somewhere it does not belong. The file is warned about if it is readable by
 *  anyone but its owner, and it is never the .env.local the app itself uses —
 *  nothing that feeds the browser bundle should be able to carry this key. */
const ADMIN_ENV_FILE = '.env.admin.local';

function resolveProjectUrl() {
  const url = process.env.TMS_ADMIN_URL?.trim() || readEnvFile('.env.local', 'VITE_SUPABASE_URL').value;
  if (!url) {
    throw new Error('Missing TMS_ADMIN_URL, and no VITE_SUPABASE_URL found in .env.local.');
  }
  return url;
}

function resolveServiceKey() {
  let key = process.env.TMS_ADMIN_SERVICE_KEY?.trim();
  if (!key) {
    const fromFile = readEnvFile(ADMIN_ENV_FILE, 'TMS_ADMIN_SERVICE_KEY');
    // 0o077 is every permission bit outside the owner.
    if (fromFile.value && (fromFile.mode & 0o077)) {
      console.warn(`Canh bao: ${ADMIN_ENV_FILE} dang cho nguoi khac doc. Chay: chmod 600 ${ADMIN_ENV_FILE}`);
    }
    key = fromFile.value;
  }
  if (!key) {
    throw new Error(
      'Missing TMS_ADMIN_SERVICE_KEY.\n\n'
      + 'Lay tai: Supabase Dashboard -> Project Settings -> API -> service_role (secret).\n\n'
      + 'Dat mot lan, dung mai (file da duoc gitignore):\n\n'
      + '  install -m 600 /dev/null ' + ADMIN_ENV_FILE + ' \\\n'
      + '    && read -rsp "Service-role key: " KEY && echo \\\n'
      + '    && printf \'TMS_ADMIN_SERVICE_KEY=%s\\n\' "$KEY" > ' + ADMIN_ENV_FILE + ' \\\n'
      + '    && unset KEY\n\n'
      + 'Hoac chi cho mot lan chay:\n\n'
      + '  read -rsp "Service-role key: " KEY && echo \\\n'
      + '    && TMS_ADMIN_SERVICE_KEY="$KEY" bun run ' + `reset:passwords${APPLY ? ' -- --apply' : ''}` + '\n',
    );
  }
  return key;
}

/** Mirrors src/core/utils/defaultPassword.ts. Kept as a copy rather than an
 *  import because this script runs against a project, not the bundle, and must
 *  stay runnable from a checkout with no build step. */
function asciiSlug(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '');
}

function accountPasswordPrefix(name) {
  const words = asciiSlug(name).split(/\s+/).filter(Boolean);
  const lastWord = words[words.length - 1];
  if (!lastWord) return '';
  return `${words.slice(0, -1).map((word) => word.slice(0, 1)).join('')}${lastWord}`;
}

function defaultAccountPassword(name, employeeId, brand) {
  const suffix = asciiSlug(brand).replace(/\s+/g, '');
  const prefix = accountPasswordPrefix(name) || asciiSlug(employeeId).replace(/\s+/g, '');
  return `${prefix}@${suffix}`;
}

const MIN_PASSWORD_LENGTH = 8;

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
    // Error bodies from PostgREST/GoTrue do not echo the key, but never widen
    // this to dump request headers.
    throw new Error(`${init.method || 'GET'} ${path} failed with ${response.status}: ${body.slice(0, 300)}`);
  }
  return body ? JSON.parse(body) : null;
}

async function main() {
  const url = resolveProjectUrl().replace(/\/+$/, '');
  const serviceKey = resolveServiceKey();
  const brand = process.env.TMS_ADMIN_BRAND?.trim() || 'genAi';
  const hostname = new URL(url).hostname;

  const extraSkips = (process.env.TMS_ADMIN_SKIP_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const skipEmails = new Set([...ALWAYS_SKIP_EMAILS, ...extraSkips]);

  const employees = await rest(
    url,
    serviceKey,
    '/rest/v1/employees?select=employee_id,name,email,auth_user_id,status&order=employee_id',
  );

  const planned = [];
  const skipped = [];
  for (const employee of employees) {
    const email = String(employee.email || '').trim().toLowerCase();
    if (skipEmails.has(email)) {
      skipped.push({ employee_id: employee.employee_id, reason: 'exempt' });
      continue;
    }
    if (!employee.auth_user_id) {
      skipped.push({ employee_id: employee.employee_id, reason: 'no auth account' });
      continue;
    }
    const password = defaultAccountPassword(employee.name || '', employee.employee_id || '', brand);
    if (password.length < MIN_PASSWORD_LENGTH) {
      skipped.push({ employee_id: employee.employee_id, reason: `derived password shorter than ${MIN_PASSWORD_LENGTH} characters` });
      continue;
    }
    planned.push({ ...employee, password });
  }

  console.log(`Project   : ${hostname}`);
  console.log(`Brand     : ${brand}`);
  console.log(`Employees : ${employees.length}`);
  console.log(`To reset  : ${planned.length}`);
  console.log(`Skipped   : ${skipped.length}`);
  for (const entry of skipped) console.log(`  - ${entry.employee_id}: ${entry.reason}`);

  if (!APPLY) {
    console.log('\nPlan only. Re-run with --apply to write these passwords.');
    return;
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const confirmation = await prompt.question(`\nType "${hostname}" to reset ${planned.length} passwords: `);
  prompt.close();
  if (confirmation.trim() !== hostname) {
    throw new Error('Hostname did not match. Nothing was changed.');
  }

  let updated = 0;
  const failures = [];
  for (const employee of planned) {
    try {
      await rest(url, serviceKey, `/auth/v1/admin/users/${employee.auth_user_id}`, {
        method: 'PUT',
        body: JSON.stringify({ password: employee.password }),
      });
      // Re-arm the reminder only after Auth accepted the new password, so a
      // failed reset never tells the employee to replace a password that still
      // works.
      await rest(url, serviceKey, `/rest/v1/employees?employee_id=eq.${encodeURIComponent(employee.employee_id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ password_change_required: true }),
      });
      updated += 1;
    } catch (error) {
      failures.push({ employee_id: employee.employee_id, message: error.message });
    }
  }

  console.log(`\nReset ${updated}/${planned.length} accounts.`);
  for (const failure of failures) console.error(`  ! ${failure.employee_id}: ${failure.message}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
