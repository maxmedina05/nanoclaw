---
name: add-zoho-workdrive
description: Let agents upload real files (PDFs, images) to Zoho WorkDrive without ever holding a Zoho credential. A host-side timer refreshes a WorkDrive access token from 1Password into OneCLI every 45 minutes; the gateway injects it into agents' requests to workdrive.zoho.eu. Use when setting up, repairing, or moving Zoho WorkDrive uploads, or when an agent gets 401s from WorkDrive.
---

# /add-zoho-workdrive: credential-free WorkDrive uploads for agents

The Zoho MCP server's WorkDrive upload tools mis-map binary file parameters as
query strings, so anything that isn't plain text (PDFs, images) arrives
corrupted. Agents upload through the WorkDrive REST API directly instead,
without ever seeing a token:

```
1Password (client id/secret/refresh token)
   │  op run, every 45 min
   ▼
scripts/zoho-token-refresher.ts  ──refresh──▶  accounts.zoho.eu
   │  onecli secrets create/update  "Zoho WorkDrive"  (generic, host workdrive.zoho.eu)
   ▼
OneCLI gateway ──injects "Authorization: Zoho-oauthtoken …"──▶ agent's POST to workdrive.zoho.eu
```

- The refresher is the **only** thing that holds the raw Zoho OAuth credentials,
  and only on the host, only for the length of a run. It never runs in a container.
- Access tokens live ~1 hour; refreshing every 45 minutes keeps one valid.
- Data center defaults to EU (`accounts.zoho.eu`, `workdrive.zoho.eu`); this
  account's WorkDrive Self Client is EU-registered. Override with `ZOHO_DC`
  (`com | eu | in | com.au | jp`).

Also included: `scripts/zoho-workdrive-upload.ts`, a host-side CLI for uploading
a file yourself (`<file-path> <folder-id>`), with its own cached token in
`data/zoho-token-cache.json`.

No NanoClaw source is touched. It's two scripts, a systemd timer, and a OneCLI
secret.

## Prerequisites

- **A Zoho Self Client** (api-console.zoho.eu) with WorkDrive scopes, and a
  refresh token for it.
- **1Password CLI** (`op`, at `~/.local/bin/op`) signed in, with a 1Password
  *environment* holding `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`,
  `ZOHO_REFRESH_TOKEN`. This install uses environment `cyg2ad3y2lzmizvwlywvzutpua`.
- **OneCLI** (`/add-onecli`) running, with the `onecli` CLI on `PATH`.

## Steps

### 1. Copy the scripts

```bash
cp .claude/skills/add-zoho-workdrive/add/scripts/zoho-*.ts scripts/
```

### 2. Run the refresher once by hand

This creates the OneCLI secret on first run, then updates it on later runs:

```bash
op run --environment cyg2ad3y2lzmizvwlywvzutpua -- pnpm exec tsx scripts/zoho-token-refresher.ts
```

Expected: `Zoho WorkDrive access token refreshed and pushed to OneCLI (host pattern: workdrive.zoho.eu).`
Then `onecli secrets list` shows a generic secret named `Zoho WorkDrive` for
`workdrive.zoho.eu`.

### 3. Install the timer

The units hardcode this install's paths (`/home/medma/nanoclaw-v2`, the nvm Node
path) and the 1Password environment id; adjust them on another machine.

```bash
cp .claude/skills/add-zoho-workdrive/add/systemd/zoho-token-refresher.service ~/.config/systemd/user/
cp .claude/skills/add-zoho-workdrive/add/systemd/zoho-token-refresher.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now zoho-token-refresher.timer
```

The timer runs 2 minutes after boot, then every 45 minutes (`Persistent=true`
catches up after downtime). Output goes to `logs/zoho-token-refresher.log`.

### 4. Give the agent the secret

Agents in OneCLI's `selective` secret mode only get secrets they're granted.
Grant `Zoho WorkDrive` to the agent that uploads (this install: **Medina Labs**)
in the OneCLI dashboard at `http://172.17.0.1:10254`. The installed CLI (2.2.5)
can't manage grants on gateway 1.45 (it returns "Gone").

### 5. Tell the agent how to upload

Add to that group's `groups/<folder>/instructions.prepend.md` (Medina Labs already has it):

````markdown
## Zoho WorkDrive uploads

Do not use the Zoho MCP WorkDrive upload tools (`ZohoWorkdrive_Upload_File`, `ZohoWorkdrive_Upload_New_Version`) — they mis-map binary file parameters as query strings, which corrupts anything that isn't plain text (PDFs, images, etc.). Instead, upload directly:

```
POST https://workdrive.zoho.eu/api/v1/upload
Content-Type: multipart/form-data

  parent_id: <WorkDrive folder ID>
  content:   <the file, as a file part with its real filename>
```

You do not need an access token or Authorization header — the host network proxy injects it automatically for requests to `workdrive.zoho.eu`. Just make the multipart POST directly (plain `fetch`/`curl` with a `FormData`/`-F` body). If you get a 401, the token refresh may be between cycles (it refreshes automatically every ~45 minutes) — wait a minute and retry once; if it persists, tell Max something is wrong with the Zoho WorkDrive credential rather than trying to fetch or construct a token yourself.

You'll need a WorkDrive folder ID to upload into — ask Max for it if it's not already clear from context, or from prior conversation/memory.
````

## Verify

```bash
systemctl --user list-timers zoho-token-refresher.timer
journalctl --user -u zoho-token-refresher.service -n 5 --no-pager
```

The last runs should say `Finished`. Then ask the agent to upload a small PDF to
a folder you name, and open it in WorkDrive to confirm it isn't corrupted.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Agent gets 401 from WorkDrive, persistently | Timer stopped (`list-timers`), refresher failing (check `logs/zoho-token-refresher.log`), or the agent wasn't granted the secret (step 4). |
| Refresher: `Zoho token refresh failed (…): {"error":"invalid_code"}` | Refresh token revoked or expired; generate a new one in the Zoho API console and update it in 1Password. |
| Refresher can't find `op` or `node` | `PATH` in the service unit; it's absolute on purpose because systemd doesn't load your shell profile. |
| Uploaded PDF is corrupted | The agent used the Zoho MCP upload tool; check its instructions (step 5). |

Removal: see [REMOVE.md](REMOVE.md).
