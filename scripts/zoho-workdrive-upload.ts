/**
 * scripts/zoho-workdrive-upload.ts — direct Zoho WorkDrive REST upload.
 *
 * Bypasses the Zoho MCP server, which maps binary file parameters as query
 * strings and only works for plain-text files. Talks to the WorkDrive REST
 * API directly instead.
 *
 * Credentials (ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN) are
 * read from the process environment. This script has no 1Password-specific
 * code — inject them per invocation with:
 *
 *   op run --environment cyg2ad3y2lzmizvwlywvzutpua -- \
 *     pnpm exec tsx scripts/zoho-workdrive-upload.ts <file-path> <folder-id>
 *
 * Data center defaults to EU (accounts.zoho.eu / workdrive.zoho.eu) — this
 * account's WorkDrive Self Client is EU-registered. Override with ZOHO_DC
 * (com | eu | in | com.au | jp) if that ever changes.
 *
 * The access token is short-lived (~1hr) and is refreshed lazily, cached to
 * disk with a TTL check so back-to-back uploads don't each pay a round trip.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const TOKEN_CACHE_PATH = path.join(DATA_DIR, 'zoho-token-cache.json');

const DC = process.env.ZOHO_DC || 'eu';
const ACCOUNTS_HOST = `https://accounts.zoho.${DC}`;
// Upload specifically goes through the workdrive.zoho.<dc> content host, not
// the www.zohoapis.<dc>/workdrive/ host used for other WorkDrive REST calls.
const UPLOAD_URL = `https://workdrive.zoho.${DC}/api/v1/upload`;

interface TokenCache {
  accessToken: string;
  expiresAt: number; // epoch ms
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name} — run via 'op run --environment <id> -- ...'`);
  }
  return value;
}

function readTokenCache(): TokenCache | null {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, 'utf8')) as TokenCache;
  } catch {
    return null;
  }
}

function writeTokenCache(cache: TokenCache): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(cache), { mode: 0o600 });
}

async function refreshAccessToken(): Promise<TokenCache> {
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
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`Zoho token refresh failed (${res.status}): ${JSON.stringify(body)}`);
  }

  const cache: TokenCache = {
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  writeTokenCache(cache);
  return cache;
}

async function getAccessToken(): Promise<string> {
  const cached = readTokenCache();
  // 60s safety margin so a token doesn't expire mid-upload.
  if (cached && cached.expiresAt - 60_000 > Date.now()) {
    return cached.accessToken;
  }
  const fresh = await refreshAccessToken();
  return fresh.accessToken;
}

async function uploadFile(filePath: string, folderId: string): Promise<unknown> {
  const accessToken = await getAccessToken();
  const fileBuffer = fs.readFileSync(filePath);
  const filename = path.basename(filePath);

  const form = new FormData();
  form.append('parent_id', folderId);
  form.append('content', new Blob([fileBuffer]), filename);

  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    body: form,
  });
  const body = await res.json();

  if (res.status === 401) {
    // Access token might have been invalidated server-side even though our
    // cached expiry hadn't hit yet — force one refresh-and-retry.
    fs.rmSync(TOKEN_CACHE_PATH, { force: true });
    const retryToken = await getAccessToken();
    const retryRes = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: `Zoho-oauthtoken ${retryToken}` },
      body: form,
    });
    const retryBody = await retryRes.json();
    if (!retryRes.ok) {
      throw new Error(`WorkDrive upload failed (${retryRes.status}) after retry: ${JSON.stringify(retryBody)}`);
    }
    return retryBody;
  }

  if (!res.ok) {
    throw new Error(`WorkDrive upload failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function main(): Promise<void> {
  const [, , filePath, folderId] = process.argv;
  if (!filePath || !folderId) {
    console.error('Usage: pnpm exec tsx scripts/zoho-workdrive-upload.ts <file-path> <workdrive-folder-id>');
    process.exit(2);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(2);
  }

  const result = await uploadFile(filePath, folderId);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
