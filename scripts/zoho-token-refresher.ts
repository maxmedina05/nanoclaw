/**
 * scripts/zoho-token-refresher.ts — keeps a Zoho WorkDrive access token live
 * in OneCLI so agent containers can call the WorkDrive REST API directly,
 * bypassing the Zoho MCP server (which mis-maps binary file params as query
 * strings and only works for plain-text files).
 *
 * Design: this script is the ONLY thing that ever holds the raw Zoho OAuth
 * credentials (client id/secret/refresh token). It never runs inside a
 * container. It refreshes the short-lived access token (~1hr TTL) and pushes
 * it into a OneCLI generic secret scoped to the WorkDrive host — from then
 * on, any HTTP call an agent container makes to that host is transparently
 * authorized by OneCLI's gateway proxy. The agent itself never sees the
 * access token, let alone the client secret or refresh token.
 *
 * Run this on a recurring host-side schedule (systemd timer — see
 * docs or the accompanying .service/.timer units), wrapped in:
 *
 *   op run --environment cyg2ad3y2lzmizvwlywvzutpua -- \
 *     pnpm exec tsx scripts/zoho-token-refresher.ts
 *
 * Credentials (ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN) come
 * from the process environment — no 1Password-specific code here.
 *
 * Data center defaults to EU (accounts.zoho.eu / workdrive.zoho.eu) — this
 * account's WorkDrive Self Client is EU-registered. Override with ZOHO_DC
 * (com | eu | in | com.au | jp) if that ever changes.
 */
import { execFileSync } from 'child_process';

const DC = process.env.ZOHO_DC || 'eu';
const ACCOUNTS_HOST = `https://accounts.zoho.${DC}`;
const WORKDRIVE_HOST = `workdrive.zoho.${DC}`;
const SECRET_NAME = 'Zoho WorkDrive';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name} — run via 'op run --environment <id> -- ...'`);
  }
  return value;
}

async function refreshAccessToken(): Promise<string> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: requireEnv('ZOHO_CLIENT_ID'),
    client_secret: requireEnv('ZOHO_CLIENT_SECRET'),
    refresh_token: requireEnv('ZOHO_REFRESH_TOKEN'),
  });

  const res = await fetch(`${ACCOUNTS_HOST}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`Zoho token refresh failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

interface OneCliSecret {
  id: string;
  name: string;
  hostPattern: string;
}

function runOnecli(args: string[]): unknown {
  const out = execFileSync('onecli', args, { encoding: 'utf8' });
  return JSON.parse(out);
}

function findExistingSecretId(): string | null {
  const result = runOnecli(['secrets', 'list']) as { data?: OneCliSecret[] };
  const match = result.data?.find((s) => s.name === SECRET_NAME && s.hostPattern === WORKDRIVE_HOST);
  return match?.id ?? null;
}

function upsertOnecliSecret(accessToken: string): void {
  const existingId = findExistingSecretId();
  // Mutable injection fields, shared between create and update.
  const injectionArgs = [
    '--value',
    accessToken,
    '--host-pattern',
    WORKDRIVE_HOST,
    '--path-pattern',
    '/*',
    '--header-name',
    'Authorization',
    '--value-format',
    'Zoho-oauthtoken {value}',
  ];

  if (existingId) {
    // 'secrets update' doesn't accept --name/--type — those are immutable.
    runOnecli(['secrets', 'update', '--id', existingId, ...injectionArgs]);
  } else {
    runOnecli(['secrets', 'create', '--name', SECRET_NAME, '--type', 'generic', ...injectionArgs]);
  }
}

async function main(): Promise<void> {
  const accessToken = await refreshAccessToken();
  upsertOnecliSecret(accessToken);
  console.log(`Zoho WorkDrive access token refreshed and pushed to OneCLI (host pattern: ${WORKDRIVE_HOST}).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
