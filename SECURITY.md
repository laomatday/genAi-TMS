# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include production employee data in a report. Send the affected deployment, app version/build ID, reproduction steps and impact to the security contact configured for that customer deployment.

Do not include passwords, session tokens, QR payloads, private keys, precise employee locations or unredacted screenshots. The release owner should acknowledge a valid report within one business day, classify severity and coordinate remediation privately.

## Supported releases

Only the current production release and the immediately previous rollback release receive security fixes. Deployments must pass `bun run check:release` and use the committed lockfile.

## Security invariants

- Frontend bundles may contain a Supabase publishable key, but never a secret/service-role key.
- Every exposed database table must use explicit grants and RLS.
- Authorization uses database-owned employee/app metadata, never user-editable auth metadata.
- Attendance evidence is immutable; corrections use auditable requests.
- Tenant identity is derived server-side and is never accepted from browser input.
- Directory data is not stored persistently in the browser.
