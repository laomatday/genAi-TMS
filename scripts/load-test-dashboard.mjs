import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { Buffer } from 'node:buffer';

const DEFAULTS = Object.freeze({
  concurrency: 10,
  durationSeconds: 30,
  requestTimeoutMs: 10_000,
  p95BudgetMs: 1_500,
  maxErrorRate: 0.01,
  maxRequestsPerSecond: 50,
  maxConcurrency: 200,
  maxDurationSeconds: 600,
});

function help() {
  console.log(`Usage: bun run test:load

Required environment:
  TMS_LOAD_TEST_URL             Supabase project URL
  TMS_LOAD_TEST_API_KEY         Publishable/anon key for staging
  TMS_LOAD_TEST_ACCESS_TOKENS   Comma-separated test-user access tokens

Optional environment:
  TMS_LOAD_TEST_CONCURRENCY     Virtual users (default ${DEFAULTS.concurrency}, max ${DEFAULTS.maxConcurrency})
  TMS_LOAD_TEST_DURATION_SECONDS Duration (default ${DEFAULTS.durationSeconds}, max ${DEFAULTS.maxDurationSeconds})
  TMS_LOAD_TEST_TIMEOUT_MS      Per-request timeout (default ${DEFAULTS.requestTimeoutMs})
  TMS_LOAD_TEST_P95_BUDGET_MS   Failing p95 threshold (default ${DEFAULTS.p95BudgetMs})
  TMS_LOAD_TEST_MAX_ERROR_RATE  Failing error-rate threshold (default ${DEFAULTS.maxErrorRate})
                                Ratio from 0 to 1; 0.01 means 1%
  TMS_LOAD_TEST_MAX_RPS         Global request-rate ceiling (default ${DEFAULTS.maxRequestsPerSecond})
  TMS_LOAD_TEST_ALLOW_REMOTE    Must be true for any non-localhost target
  TMS_LOAD_TEST_ENVIRONMENT     Must be staging for a remote target
  TMS_LOAD_TEST_CONFIRM_HOST    Must exactly match the remote URL hostname

The script never prints credentials and refuses remote targets unless explicitly enabled.`);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  help();
  process.exit(0);
}

function numberFromEnv(name, fallback, { min, max, integer = false }) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
  }
  return value;
}

function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return Math.round((sorted[index] ?? 0) * 100) / 100;
}

function requireValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function jwtClaims(value, name) {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error(`${name} must be a user JWT.`);
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error(`${name} contains an invalid JWT payload.`);
  }
}

const baseUrl = new URL(requireValue('TMS_LOAD_TEST_URL'));
const isLocal = ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname);
if (!isLocal && (
  process.env.TMS_LOAD_TEST_ALLOW_REMOTE !== 'true'
  || process.env.TMS_LOAD_TEST_ENVIRONMENT !== 'staging'
  || process.env.TMS_LOAD_TEST_CONFIRM_HOST !== baseUrl.hostname
)) {
  throw new Error(
    'Remote load tests require ALLOW_REMOTE=true, ENVIRONMENT=staging and CONFIRM_HOST matching the target hostname.',
  );
}
if (!isLocal && baseUrl.protocol !== 'https:') {
  throw new Error('Remote load-test targets must use HTTPS.');
}

const apiKey = requireValue('TMS_LOAD_TEST_API_KEY');
if (apiKey.startsWith('sb_secret_')) {
  throw new Error('TMS_LOAD_TEST_API_KEY must never be a secret/service-role key.');
}
if (apiKey.split('.').length === 3 && jwtClaims(apiKey, 'TMS_LOAD_TEST_API_KEY').role === 'service_role') {
  throw new Error('TMS_LOAD_TEST_API_KEY must never be a service-role JWT.');
}
const accessTokens = requireValue('TMS_LOAD_TEST_ACCESS_TOKENS')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
if (!accessTokens.length) throw new Error('TMS_LOAD_TEST_ACCESS_TOKENS has no usable token.');
for (const [index, token] of accessTokens.entries()) {
  const claims = jwtClaims(token, `TMS_LOAD_TEST_ACCESS_TOKENS[${index}]`);
  if (claims.role !== 'authenticated' || typeof claims.sub !== 'string' || !claims.sub) {
    throw new Error(`TMS_LOAD_TEST_ACCESS_TOKENS[${index}] must belong to an authenticated test user.`);
  }
}

const config = Object.freeze({
  concurrency: numberFromEnv(
    'TMS_LOAD_TEST_CONCURRENCY',
    DEFAULTS.concurrency,
    { min: 1, max: DEFAULTS.maxConcurrency, integer: true },
  ),
  durationSeconds: numberFromEnv(
    'TMS_LOAD_TEST_DURATION_SECONDS',
    DEFAULTS.durationSeconds,
    { min: 1, max: DEFAULTS.maxDurationSeconds, integer: true },
  ),
  requestTimeoutMs: numberFromEnv(
    'TMS_LOAD_TEST_TIMEOUT_MS',
    DEFAULTS.requestTimeoutMs,
    { min: 250, max: 120_000, integer: true },
  ),
  p95BudgetMs: numberFromEnv(
    'TMS_LOAD_TEST_P95_BUDGET_MS',
    DEFAULTS.p95BudgetMs,
    { min: 1, max: 120_000 },
  ),
  maxErrorRate: numberFromEnv(
    'TMS_LOAD_TEST_MAX_ERROR_RATE',
    DEFAULTS.maxErrorRate,
    { min: 0, max: 1 },
  ),
  maxRequestsPerSecond: numberFromEnv(
    'TMS_LOAD_TEST_MAX_RPS',
    DEFAULTS.maxRequestsPerSecond,
    { min: 1, max: 500, integer: true },
  ),
});

const endpoint = new URL('/rest/v1/rpc/tms_dashboard_bundle_v1', baseUrl);
const durations = [];
const errors = new Map();
let successCount = 0;
let requestCount = 0;
const startedAt = performance.now();
const deadline = startedAt + config.durationSeconds * 1_000;
const requestIntervalMs = 1_000 / config.maxRequestsPerSecond;
let nextPermitAt = startedAt + requestIntervalMs;

async function waitForRequestPermit() {
  const permitAt = Math.max(nextPermitAt, performance.now());
  if (permitAt >= deadline) return false;
  nextPermitAt = permitAt + requestIntervalMs;
  const waitMs = permitAt - performance.now();
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  return performance.now() < deadline;
}

async function virtualUser(workerIndex) {
  let iteration = 0;
  while (performance.now() < deadline) {
    if (!await waitForRequestPermit()) break;
    const token = accessTokens[(workerIndex + iteration) % accessTokens.length];
    const requestStartedAt = performance.now();
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          apikey: apiKey,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ p_history_days: 120 }),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      const payload = await response.json().catch(() => null);
      requestCount += 1;
      durations.push(performance.now() - requestStartedAt);
      const validDashboard = payload
        && typeof payload === 'object'
        && payload.bootstrap
        && typeof payload.bootstrap === 'object'
        && !Array.isArray(payload.bootstrap)
        && payload.bootstrap.profile
        && typeof payload.bootstrap.profile === 'object'
        && !Array.isArray(payload.bootstrap.profile)
        && typeof payload.bootstrap.profile.employee_id === 'string'
        && payload.bootstrap.profile.employee_id.trim().length > 0;
      if (response.ok && validDashboard) successCount += 1;
      else if (!response.ok) {
        const key = `HTTP_${response.status}`;
        errors.set(key, (errors.get(key) || 0) + 1);
      } else {
        errors.set('INVALID_RESPONSE', (errors.get('INVALID_RESPONSE') || 0) + 1);
      }
    } catch (error) {
      requestCount += 1;
      durations.push(performance.now() - requestStartedAt);
      const key = error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR';
      errors.set(key, (errors.get(key) || 0) + 1);
    }
    iteration += 1;
  }
}

await Promise.all(Array.from({ length: config.concurrency }, (_, index) => virtualUser(index)));

const elapsedSeconds = Math.max((performance.now() - startedAt) / 1_000, Number.EPSILON);
const sortedDurations = durations.sort((left, right) => left - right);
const errorCount = requestCount - successCount;
const errorRate = requestCount ? errorCount / requestCount : 1;
const summary = {
  target: endpoint.origin,
  concurrency: config.concurrency,
  testUsers: accessTokens.length,
  durationSeconds: Math.round(elapsedSeconds * 100) / 100,
  requests: requestCount,
  requestsPerSecond: Math.round((requestCount / elapsedSeconds) * 100) / 100,
  requestRateCeiling: config.maxRequestsPerSecond,
  successes: successCount,
  errorRate: Math.round(errorRate * 10_000) / 10_000,
  latencyMs: {
    p50: percentile(sortedDurations, 0.5),
    p95: percentile(sortedDurations, 0.95),
    p99: percentile(sortedDurations, 0.99),
    max: percentile(sortedDurations, 1),
  },
  errors: Object.fromEntries([...errors.entries()].sort()),
  budgets: {
    p95Ms: config.p95BudgetMs,
    maxErrorRate: config.maxErrorRate,
  },
};

console.log(JSON.stringify(summary, null, 2));

const failed = requestCount === 0
  || successCount === 0
  || errorRate > config.maxErrorRate
  || (summary.latencyMs.p95 ?? Infinity) > config.p95BudgetMs;
if (failed) {
  console.error('Dashboard load-test budget failed.');
  process.exit(1);
}
console.log('Dashboard load-test budget passed.');
