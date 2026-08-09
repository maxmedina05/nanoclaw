# NanoClaw Operator Reference

A single self-contained reference for configuring and operating NanoClaw v2.

**Who this is for.** A human operator, or an AI agent asked to configure a NanoClaw
install. It is written to be pasted into an agent's context whole: dense, factual,
command-first, no prose that does not carry a fact. Everything here is derived from
the v2 source tree.

**How to use it as an agent.** Treat the `ncl` reference in §11 as a snapshot, not
the authority. `ncl <resource> help <verb>` is generated from the same declarations
and is always current. An invalid invocation prints that verb's full usage block
alongside the error, so a failed call is usually enough to self-correct without a
separate help round-trip.

---

## 1. Mental model

A single Node process on the host orchestrates one Docker container per session.
Each container runs an agent (Claude by default) on Bun.

```
messaging app → host router → inbound.db → container agent → outbound.db → host delivery → messaging app
```

**Everything is a message.** There is no IPC, no file watcher, no stdin piping
between host and container. The two session SQLite files are the entire IO surface,
and each has exactly one writer:

- `inbound.db` — host writes, container reads (`messages_in`, delivered, destinations, session_routing)
- `outbound.db` — container writes, host reads (`messages_out`, processing_ack, session_state, container_state)

Heartbeat is a file touch at `/workspace/.heartbeat`, not a DB write. The host uses
even `seq` numbers; the container uses odd.

The security model is **isolation, not permission checks**. The agent has full bash
inside its container. That is safe because the container sees only what was
explicitly mounted.

### Entity model

```
users (id "<channel>:<handle>", kind, display_name)
user_roles (user_id, role, agent_group_id)        — owner | admin (global or group-scoped)
agent_group_members (user_id, agent_group_id)     — unprivileged access gate
user_dms (user_id, channel_type, messaging_group_id) — cold-DM cache

agent_groups (workspace, memory, personality, container config)
    ↕ many-to-many via messaging_group_agents ("wirings")
messaging_groups (one chat/channel on one platform)

sessions (agent_group_id + messaging_group_id + thread_id → one container)
```

| Entity | Definition |
|---|---|
| User | One identity on one platform. Id is `<channel>:<handle>`, e.g. `telegram:6037840640`. |
| Messaging group | One chat or channel on one platform. Identity is the unique triple `(channel_type, platform_id, instance)`. |
| Agent group | An agent identity: its own workspace folder, memory, personality, container image and config. |
| Wiring | Links a messaging group to an agent group; carries the engagement rules. |
| Session | Runtime unit. Created automatically by the router. |

**Privilege attaches to users, not agent groups.** There is no "admin agent". The
router-side command gate queries `user_roles` directly on the host — no env var of
admin ids, no container-side check to bypass.

### Path map

| Path | Contents |
|---|---|
| `data/v2.db` | Central DB: users, roles, agent groups, messaging groups, wirings, container configs, approvals, schema_version |
| `data/v2-sessions/<group-id>/<session-id>/` | `inbound.db` + `outbound.db` |
| `data/cli.sock` | Unix socket the host `ncl` client connects to |
| `groups/<folder>/` | Agent workspace: `instructions.prepend.md`, `memory/`, `skills/`, `tasks/`, generated `CLAUDE.md`, `container.json` |
| `logs/nanoclaw.log`, `logs/nanoclaw.error.log` | Host logs — read the error log first |
| `logs/setup.log`, `logs/setup-steps/*.log` | Install progression log; raw per-step output |
| `~/.config/nanoclaw/mount-allowlist.json` | Which host dirs may ever be mounted. Deliberately outside the repo. |
| `templates/` | Local agent-template library (ships empty) |

Inside a container: session folder → `/workspace`, agent group folder →
`/workspace/agent`.

---

## 2. What it is and is not good for

**Good fit:** a self-hosted personal assistant reachable from a messaging app;
gated recurring monitoring; long-horizon work where memory matters; small-team ops
bots with an explicit access list; privacy-sensitive work; agentic coding on a
schedule.

**Bad fit:** multi-tenant SaaS (no accounts, no billing, no tenancy); sub-second
latency (container spawn + model turn is seconds); high-frequency polling (ungated
tasks cap at 4/day by design); no-code configuration (customization means editing
code — stated philosophy, not a gap); zero-maintenance appliance; untrusted public
exposure; deterministic pipelines.

**What it does that Claude / Claude Code cannot alone:** run when nobody is present;
be reachable from WhatsApp / Telegram / Slack / iMessage / email; hold cron-scheduled
work with run history; keep file-based memory that survives every session and
provider switch; spawn other *persistent* agents that message back; hold credentials
the container itself never sees.

---

## 3. Install

Requirements: macOS or Linux (Windows via WSL2); Node 20+ and pnpm 10+ (installer
handles both); Docker Desktop or Docker Engine; Claude Code on the host for
`/customize`, `/debug`, `/add-<channel>` skills and setup error recovery.

```bash
git clone https://github.com/nanocoai/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash nanoclaw.sh
```

Phase 1 bootstraps the toolchain. Phase 2 is the interactive wizard: Docker check,
Anthropic credential registration, agent image build, OneCLI vault, mount allowlist,
service install, timezone, first channel. On failure it hands off to Claude Code to
diagnose and resume.

Anthropic credential registration is the one deliberate break in the wizard flow:
`claude setup-token` takes the TTY and opens a browser for OAuth. NanoClaw does not
re-implement or intercept that flow.

```bash
pnpm run chat hi          # talk to the CLI-wired agent from the terminal
pnpm run dev              # run the host in the foreground
./container/build.sh      # rebuild the agent image

# service
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS restart
systemctl --user restart nanoclaw                   # Linux restart

# uninstall — slug-scoped to this checkout only
bash nanoclaw.sh --uninstall [--dry-run] [--yes]
```

**v1 → v2:** never `git pull` v2 into a v1 checkout. Clone fresh and run
`bash migrate-v2.sh` from a real shell (it needs interactive prompts and cannot run
inside a Claude Code session). Your v1 install is left untouched until you choose to
switch the service over.

---

## 4. Channels and isolation

Trunk ships **no** channel adapters. Adapters live on a long-lived `channels` branch;
each `/add-<channel>` skill fetches it, copies the module in, wires the
self-registration import, pins the dep and rebuilds. Idempotent.

Available: `/add-whatsapp` `/add-telegram` `/add-discord` `/add-slack` `/add-imessage`
`/add-teams` `/add-signal` `/add-matrix` `/add-gchat` `/add-webex` `/add-wechat`
`/add-deltachat` `/add-whatsapp-cloud` `/add-resend` (email) `/add-github` `/add-linear`
`/add-emacs`.

```bash
ncl messaging-groups create --channel-type telegram --platform-id 6037840640 \
  --name "Max DM" --is-group 0

ncl wirings create --channel-type telegram --platform-id 6037840640 \
  --agent-group andy --session-mode shared --engage-mode mention
```

Omitted engagement flags default to the channel adapter's declaration for that
context (DM vs group). Guided path: `/manage-channels`.

### The three isolation levels

Deciding question: *are you okay with any piece of information from one channel being
available in the other?*

| Level | Config | Shares | Use when |
|---|---|---|---|
| 1 — Shared session | `session_mode: agent-shared` | Everything, including the conversation | One channel feeds context into another (GitHub + Slack) |
| 2 — Same agent, separate sessions | `session_mode: shared` or `per-thread` | Workspace, memory, personality — not the thread | You are the primary participant across channels |
| 3 — Separate agent groups | Different `agent_group_id` | Nothing | Different **people** are involved, or a confidentiality boundary exists |

Levels 1 and 2 share one `memory/` tree. A confidentiality boundary must be a
separate agent group — memory cross-pollinates otherwise.

### Engagement settings (on the wiring)

| Field | Values | Meaning |
|---|---|---|
| `engage_mode` | `mention` (default) | Only when @mentioned; always in DMs |
| | `mention-sticky` | Once mentioned in a thread, subscribes to everything after |
| | `pattern` | Every message tested against `engage_pattern`; `"."` = always-on |
| `engage_pattern` | regex | Required when mode is `pattern`; ignored for mention modes |
| `sender_scope` | `all` / `known` | `known` = only users with a role or membership in this agent group |
| `ignored_message_policy` | `drop` / `accumulate` | `accumulate` stores non-triggering messages as background context |
| `session_mode` | `shared` / `per-thread` / `agent-shared` | Threaded adapters in group chats force per-thread regardless |
| `threads` | `true` / `false` / unset | Per-wiring override. Can disable threads on a threaded platform; never enable on one without |
| `priority` | number | Fanout order when several agents are wired to one chat; higher first |

---

## 5. Personality, memory, configuration

| To change | Edit | Approval |
|---|---|---|
| Role, tone, standing rules | `groups/<folder>/instructions.prepend.md` | none |
| Durable facts, people, projects | `groups/<folder>/memory/` | none |
| Model, effort, name, timezone, CLI scope | `ncl groups config update` | admin |
| apt / npm packages | `install_packages` or `ncl groups config add-package` | admin |
| MCP servers | `add_mcp_server` or `ncl groups config add-mcp-server` | admin |
| Host directory access | `ncl groups config add-mount` | **operator only** |

> **Never edit `groups/<folder>/CLAUDE.md`.** It is composed from scratch on every
> container spawn from the shared base + skill fragments + MCP fragments +
> `instructions.prepend.md`. Edits are silently overwritten.
> `instructions.prepend.md` is imported *first*, at the top of the system prompt.

### Memory

Plain Markdown on disk. No database, no embedding store. Survives restarts, session
ends, compaction, and provider switches.

```
groups/<folder>/memory/
├── index.md              # Core Memory + map of everything else — ALWAYS loaded
└── system/
    ├── index.md          # folder index (not injected)
    └── definition.md     # how this agent's memory behaves — ALWAYS loaded
```

A session-start hook injects `index.md` and `system/definition.md` whenever the
provider opens a fresh context window (startup, clear, post-compaction), each capped
at 16k characters. Everything deeper is reached by following links. Resuming an
existing session injects nothing.

The tree is an **OKF v0.1** bundle: one concept per file, YAML frontmatter with a
`type` (`person`, `project`, `decision` — the agent's vocabulary, not a fixed list).
`index.md` and `log.md` are exempt. Malformed frontmatter still works; the agent
repairs it on next touch. Scaffold templates live at
`container/agent-runner/src/memory/templates/` and are only ever copied when missing —
never overwritten.

Legacy memory (`.seed.md`, notes in `CLAUDE.md`/`CLAUDE.local.md`, Claude auto-memory,
`imported-agent-memory.md`) migrates via `/migrate-memory`.

### Container config

```bash
ncl groups config get --id <group-id>

ncl groups config update --id <group-id> \
  --model claude-opus-5 --effort high --assistant-name "Andy" \
  --timezone "Europe/Lisbon" --max-messages-per-prompt 40 --cli-scope group

ncl groups restart --id <group-id>                       # REQUIRED for config to apply
ncl groups restart --id <group-id> --rebuild --message "ffmpeg installed — verify it"
```

`--rebuild` rebuilds the image first (required after package changes). `--message`
queues an on-wake instruction the *fresh* container acts on; without it the container
stops and returns on the next user message. The `on_wake` column guarantees a dying
container in its SIGTERM grace period can never steal that message.

### `cli_scope`

| Value | Agent's `ncl` access |
|---|---|
| `disabled` | Never learns `ncl` exists (excluded from CLAUDE.md); host rejects any `cli_request` |
| `group` (default) | Only `groups`, `sessions`, `destinations`, `members`, `tasks`, scoped to own group. `--id` and group args auto-fill. Cross-group rejected. Cannot change own `cli_scope`. |
| `global` | Unrestricted. Set automatically for owner agent groups by `init-first-agent`. |

### Timezone

Per-group override grounds cron interpretation, `--process-after` parsing, and
run-log stamps **immediately**; the container's `TZ` follows on respawn. Host-side
operator display stays in the install timezone. Resolution: group override → install
global. `--timezone ""` clears.

### Templates

```bash
ncl groups create --template sales/sdr --name "SDR Agent"
```

Standing instructions + MCP servers + skills + optional recurring tasks (created
**paused**). No secrets, no provider. Resolved **only** from a local directory
(`templates/`, or `NANOCLAW_TEMPLATES_DIR` — a local path, never a URL). Absolute
paths, leading `~`, and `../` escapes are rejected. Stamping does not wire a channel.

---

## 6. Sub-agents and multi-agent

Two mechanisms, same word:

| | SDK sub-agent | `create_agent` |
|---|---|---|
| Mechanism | The agent's built-in `Agent` tool, inside its container | New agent group on the host |
| Lifetime | One shot, dies with the turn | Indefinite |
| State | None | Own container, workspace, memory, personality |
| Blocking | Blocks the turn | Fire-and-forget; returns before the child is up |
| Use for | One-off lookups, parallel searches | Companions that accumulate context; collaborators that work independently |

```
mcp__nanoclaw__create_agent({
  name: "Researcher",
  instructions: "You are a research agent working for Andy. Report back with
                 send_message({ to: 'parent' }) only when you have a conclusion."
})
```

Creates the group, writes `instructions` to its `instructions.prepend.md`, and
inserts **bidirectional** destination rows (parent → `<name>`, child → `parent`).
The child inherits the parent's *effective* provider, not the instance default — so
a child is never spawned on a runtime the parent cannot reach.

> `create_agent` writes to the central DB and scaffolds host filesystem state — a
> privileged operation a confined container is architecturally barred from.
> Authorization is enforced **host-side**: only a trusted `global`-scope group passes
> directly. Everything else, including unknown config (fail-closed), holds for admin
> approval. The container-side MCP gate is inside the untrusted container and is not
> the security boundary.

### Destinations are the ACL

An agent can only send to a target it holds a destination row for. `local_name` is
scoped to the sending agent, so two agents may call the same target different things.

```bash
ncl destinations list --agent-group-id <group-id>
ncl destinations add --agent-group-id <id> --local-name ops-slack \
  --target-type channel --target-id <messaging-group-id>
ncl destinations remove --agent-group-id <id> --local-name ops-slack
```

`ncl wirings create` writes the companion destination row and projects it into any
running container, so a new chat works without a restart. **A reply that silently
vanishes is almost always a missing destination row** — delivery's ACL drops
outbound messages with no matching destination.

### Agent-to-agent approval gates

Directed, per-pair, operator-only. Gate both directions with two rows. No row = free
flow.

```bash
ncl policies set --from <child-id> --to <parent-id> --approver telegram:6037840640
ncl policies remove --from <child-id> --to <parent-id>
```

---

## 7. Scheduled tasks

Tasks run in the agent group's own system session, separate from any chat. Requires
`--prompt` plus **either** `--recurrence` **or** `--process-after`. Always pass
`--name` for a readable id (`<slug>-<hex>`; without it, `t-<hex>`).

```bash
# recurring — first run derived from the cron grid
ncl tasks create --group <group-id> --name "weekday briefing" \
  --recurrence "0 9 * * 1-5" \
  --prompt "Compile the weekday briefing and send it to telegram"

# one-shot — --process-after required (ISO 8601 or naive local)
ncl tasks create --group <group-id> --name "call reminder" \
  --process-after "2026-09-14T18:00:00+03:00" \
  --prompt "Remind me to call Dana"
```

Inside a container `--group` auto-fills. Cron and naive timestamps are interpreted in
the owning group's timezone.

> **A task has no chat attached.** If output should reach a human, the **prompt** must
> say where to send it, using a destination name that agent actually holds. The
> agent's final response text is written to the run log only and is delivered to
> nobody. This is the single most common reason a task "does not send".

### Reviewing

```bash
ncl tasks list                        # all groups (host default)
ncl tasks list --group <group-id>
ncl tasks list --status paused
ncl tasks get weekday-briefing-a25c   # full prompt, script, run counts, recent log
```

A series is CronJob-like: the live pending/paused row is the next run; `completed`
rows are history. `list` renders schedule, runs, failed_runs, last fire, next fire,
and a run-log pointer. Run logs are Markdown at
`groups/<folder>/tasks/<series-id>.md`, readable directly on the host. Every run
auto-logs its final text; add mid-run notes with
`ncl tasks append-log --msg "..."` (a log entry, not a message; `--id` auto-derives
inside a task run).

### Managing

| Command | Effect |
|---|---|
| `ncl tasks run <id>` | Fire one extra run now. Does **not** consume a one-shot or advance a recurring series. Safe test path; works while paused. |
| `ncl tasks pause <id>` / `resume <id>` | Stop / restart firing, keep the series |
| `ncl tasks update <id>` | `--prompt`, `--recurrence` (`"null"`/`"none"` clears), `--process-after`, `--script` (`"null"` removes) |
| `ncl tasks cancel <id>` | Stop the live task, keep history. `--all` = kill switch |
| `ncl tasks delete <id>` | Hard-delete the series **and** its history |

### Script gates

A Bash script runs **before** the agent wakes and decides whether waking is worth it.

| Rule | Value |
|---|---|
| Interpreter | bash |
| Timeout | 30 s |
| Output cap | 1 MB |
| Decision | **Last** stdout line must be `{"wakeAgent": <bool>, "data": {...}}` |
| `wakeAgent: false` | Run marked handled; model never called; zero tokens |
| `wakeAgent: true` | Agent wakes with `data` attached to the prompt |
| State between runs | Persist under the group workspace, e.g. `/workspace/agent/last-seen-id` |

Do: print the JSON as the very last line, exit 0, keep `data` small. Don't: print
anything after the JSON, prompt for input, or rely on in-memory state from previous
runs. Always test with `bash -c '<script>'` first.

```bash
ncl tasks create --group <group-id> --name "alert watch" \
  --recurrence "*/15 * * * *" \
  --prompt "Investigate the alerts in the script data and notify me if serious" \
  --script 'c=$(curl -sf https://example.com/api/alerts | jq length) || exit 0
echo "{\"wakeAgent\": $([ "$c" -gt 0 ] && echo true || echo false), \"data\": {\"alerts\": $c}}"'
```

### Frequency limit and backoff

Ungated recurrences firing **more than 4 times/day** are refused. Two ways through:
attach a `--script` gate (preferred — quiet fires cost nothing), or pass
`--dangerously-override-recurrence-limit`, only after a human has explicitly
confirmed they accept the token and quota cost.

A script that **errors** (timeout, nonzero exit, missing decision, invalid JSON)
counts as a failed run and backs the series off 2, 4, 8, 16, 32, then 60 minutes,
holding at 60. After **8 consecutive failures** the series auto-pauses with the
reason in its run log — fix, test, then `ncl tasks resume <id>`. A deliberate
`wakeAgent: false` is a successful run and never backs off.

---

## 8. MCP servers, credentials, OAuth

### Adding a server

```bash
# host, as operator
ncl groups config add-mcp-server --id <group-id> --name memory \
  --command pnpm --args '["dlx","@modelcontextprotocol/server-memory"]' \
  --env '{"SOME_FLAG":"1"}'
ncl groups config remove-mcp-server --id <group-id> --name memory
ncl groups restart --id <group-id>     # REQUIRED. No rebuild — bun runs TS directly.
```

```
# from the agent — admin approval, then automatic restart
add_mcp_server({ name: "memory", command: "pnpm", args: ["dlx", "@modelcontextprotocol/server-memory"] })
```

```json
// in a template, as .mcp.json
{ "mcpServers": { "exa": { "command": "npx", "args": ["-y", "exa-mcp-server"] } } }
```

An MCP server may ship an `instructions` field, composed into the agent's system
prompt as a fragment at spawn — that is how the agent learns what the tools are *for*.

**MCP servers need `restart`. Packages need `restart --rebuild`.**

### The credential model

Agents never hold raw API keys. Outbound HTTPS from the container routes through
**OneCLI's Agent Vault**, a host-side proxy that injects credentials at the proxy
boundary, matched by API host, at request time.

```bash
curl -s "https://api.github.com/user/repos?per_page=10"   # no auth header anywhere
```

Standard clients (curl, fetch, requests, axios, Go net/http, git) honor `HTTPS_PROXY`
automatically — no code needed in the MCP server. Consequences: a prompt injection
cannot exfiltrate a key the container never had, and revocation is a vault operation,
not a rebuild.

**Secret modes.** Auto-created vault agents default to `all` — every stored secret
whose host pattern matches is injected. A `selective` agent gets nothing until
assigned, which surfaces as a `401` from an API whose credential you know is stored.

```bash
onecli agents list                                          # check secretMode
onecli agents set-secret-mode --id <agent-id> --mode all
onecli agents set-secrets --id <agent-id> --secret-ids ...
```

No restart needed — the gateway looks secrets up per request.

### OAuth2 that must happen on the host machine

**OAuth never happens inside the container.** It has no browser and no loopback
redirect. Four host-side routes, in preference order:

1. **OneCLI dashboard.** Open `http://127.0.0.1:10254` in the browser *on the host*
   and connect the app there. Consent, redirect, token exchange and refresh all happen
   host-side. The container just calls the real API URL.
2. **On demand.** Set nothing up. The agent's first call returns 401/403 with a
   `connect_url`; it shows you the link, you authorize on the host, you tell it to
   retry. This is the common path.
3. **Host-run MCP server.** When a server genuinely needs host resources (system
   keychain, a desktop app, a loopback OAuth listener), run it on the host and reach
   it from the container at `host.docker.internal`. Linux gets
   `--add-host=host.docker.internal:host-gateway` automatically. `/add-ollama-tool`
   and `/add-atomic-chat-tool` are working examples.
4. **Mount the host credential directory.** Last resort, operator-only.

```bash
# route 4 — allowlist the root once
pnpm exec tsx setup/index.ts --step mounts --force -- --json \
  '{"allowedRoots":[{"path":"/Users/max/.config/some-tool","allowReadWrite":false}],"blockedPatterns":[]}'

# then mount it into one group, read-only
ncl groups config add-mount --id <group-id> \
  --host /Users/max/.config/some-tool \
  --container /home/node/.config/some-tool --ro
ncl groups restart --id <group-id>
```

> **Mount allowlist caveat.** The blocked-pattern list (`.ssh`, `.aws`, `.gnupg`, …)
> is checked **once, against the realpath of the mount root, and does not descend**.
> It stops you *naming* one of those paths as a mount; it does nothing about what
> lives underneath an allowed root. Allowlisting `~` or `~/.config` exposes every
> credential below it regardless. Mount the narrowest directory possible, read-only,
> and prefer routes 1–3.

**Servers that refuse to boot without a credential env var:** use a placeholder,
never a real key.

```json
{ "mcpServers": { "acme": { "command": "npx", "args": ["-y", "@acme/mcp-server"],
                            "env": { "ACME_API_KEY": "onecli-managed" } } } }
```

Same convention for credential *files*: write a stub with `"onecli-managed"` as every
secret value, mode `0600`. Files containing that marker are OneCLI-managed and must
not be edited or deleted. The `onecli-gateway` container skill teaches the agent this
flow, including never to ask a user for a raw key or invent credential-setup steps.

### Approval-gated credential use

Two-sided. Both halves must be live or it fails silently in opposite directions.

- **Server side** (the vault) decides when to hold a request, matched on host +
  method + path. As of `onecli@2.2.5` this is configurable **only** through the web
  UI at `http://127.0.0.1:10254` — the CLI's `rules create --action` accepts only
  `block` and `rate_limit`.
- **Host side** (NanoClaw) routes the hold to a person via a long-polling callback,
  DMing an approver resolved from `user_roles`: scoped admins for the group → global
  admins → owners.

If the vault holds but the host callback is not running, every credentialed call
hangs until the gateway times out. If the vault has no rule, the callback never fires.

### Providers

Per agent group. Claude is built in; the rest install from the `providers` branch.

| Skill | Provider | Backends |
|---|---|---|
| *built in* | `claude` | Anthropic, via the official Claude Agent SDK |
| `/add-codex` | `codex` | OpenAI Codex app-server; ChatGPT subscription or API key |
| `/add-opencode` | `opencode` | OpenRouter, OpenAI, Google, DeepSeek, … |
| `/add-ollama-provider` | `claude` + env overrides | Local open-weight models (Ollama speaks the Anthropic API natively) |

```bash
ncl groups config update --id <group-id> --provider codex
ncl groups restart --id <group-id>
```

Memory carries across a provider switch — that is what the portable OKF format buys.
Run `/migrate-memory` if the group still holds provider-specific legacy memory.

> **Provider ≠ MCP tool.** `/add-ollama-provider` makes a local model *be* the agent.
> `/add-ollama-tool` keeps Claude as planner and lets it *call* local models as a tool.
> Same distinction for `/add-codex` vs. using OpenAI through an MCP server.

---

## 9. Access control and onboarding

| Tier | Scope | Can do |
|---|---|---|
| Owner | Always global | Everything. Approves anything. Cannot be group-scoped. |
| Admin | Global, or scoped to one agent group | Manage groups, approve held actions. Implies membership. |
| Member | One agent group | Talk to that agent. No privileges. |
| Unknown | — | Governed by the chat's `unknown_sender_policy` |

```bash
ncl users create --id telegram:6037840640 --kind telegram --display-name "Dana"
ncl members add --user telegram:6037840640 --group <agent-group-id>     # plain access
ncl roles grant --user telegram:6037840640 --role admin --group <id>    # scoped admin
ncl roles grant --user telegram:6037840640 --role admin                 # global admin
ncl roles revoke --user telegram:6037840640 --role admin --group <id>
ncl members remove --user telegram:6037840640 --group <id>
```

### Unknown senders

Set per chat; default comes from the channel adapter's declaration for that context.

| `unknown_sender_policy` | Behavior | Use when |
|---|---|---|
| `strict` (fallback default) | Dropped silently, logged to `dropped-messages` | Private assistant. Almost always right. |
| `request_approval` | Approval card sent to an admin | Group chat where new people legitimately join |
| `public` | Anyone may talk to the agent | Rarely. Only for an agent with no private context. |

```bash
ncl messaging-groups update <mg-id> --unknown-sender-policy request_approval
ncl dropped-messages list
ncl dropped-messages list --reason no_agent_wired
```

Drop reasons: `no_agent_wired` (no wiring), `no_agent_engaged` (wiring exists but
engage rules did not fire — usually a missing @mention), `unknown_sender_strict`,
`unknown_sender_request_approval`. When someone says "it ignored me", this table
names the reason.

### Approvals

Privileged actions do not execute then ask forgiveness. They return
`approval-pending` immediately; a card goes to an approver; on approve the action
replays with the approval row as its grant and re-runs the same checks.

Approver preference: scoped admins for the group → global admins → owners, favoring
someone reachable on the platform the request came from.

```bash
ncl approvals list --status pending
ncl approvals get <approval-id>
```

Hold: `install_packages`, `add_mcp_server`, `create_agent` from a non-global-scope
agent, most `ncl` writes from inside a container, unknown-sender admission, and any
vault-gated credentialed call. **Do not hold:** an agent managing its own group's
scheduled tasks.

First agent bootstrap: `/init-first-agent` resolves your channel identity, creates the
agent, grants owner, wires your DM, and triggers the welcome through the normal
delivery path — so a successful welcome also proves the pipeline.

---

## 10. Agent-facing tools

Available inside the container beyond the standard file/bash/web toolset. MCP prefix
is `mcp__nanoclaw__`.

| Tool | Purpose |
|---|---|
| `send_message({ to, text })` | Send to a named destination. `to` is always explicit — no implicit reply target. |
| `send_file({ to, path, text?, filename? })` | Deliver an artifact as a real file. `path` is absolute or relative to `/workspace/agent/`. |
| `edit_message(...)` | Edit an already-delivered message where the platform supports it |
| `add_reaction({ messageId, emoji })` | React by inbound `#N` id. `messageId` is an integer, `emoji` a shortcode (`thumbs_up`), not the character. |
| `ask_user_question({ title, question, options, timeout? })` | Multiple choice; **blocks the turn** until answered or timed out (default 300 s) |
| `send_card({ card, fallbackText? })` | Structured card with actions. Returns immediately; does not collect a response. |
| `create_agent({ name, instructions })` | Spawn a persistent agent, wired bidirectionally |
| `install_packages({ apt, npm, reason })` | Persistent packages. Admin approval → rebuild + restart automatically. |
| `add_mcp_server({ name, command, args })` | Wire in an MCP server. Admin approval → restart, no rebuild. |
| `ncl …` | Admin CLI at `/usr/local/bin/ncl`, scoped by `cli_scope` |

Scratch reasoning goes in `<internal>…</internal>` — logged, never sent.

Container skills mounted into every session: `agent-browser` (real headless
browsing), `frontend-engineer`, `onecli-gateway` (credential flow and 401 recovery),
`self-customize` (self-modification decision tree + the builder-agent pattern),
`welcome` (first-contact onboarding). Opt-in extras (`vercel-cli`, Slack and WhatsApp
formatters) arrive with the `/add-*` skill that adds their capability.

---

## 11. `ncl` reference

```
ncl <resource> <verb> [<id>] [--flags]
ncl <resource> help              # fields, types, enums, verbs
ncl <resource> help <verb>       # one verb in depth, with examples
ncl help                         # everything available to you
```

Host transport: Unix socket at `data/cli.sock`. Container transport: the session DB,
subject to `cli_scope`. If the host binary is not on PATH, `pnpm run ncl -- <args>`
is equivalent.

**Conventions.** Flags are `--hyphen-case`, mapped to `underscore_case` DB columns.
`list` accepts any non-generated column as an equality filter; default limit 200
(`--limit N`); rows newest first. `create` is idempotent where a natural key exists.
Write verbs from inside a container return `approval-pending` immediately — not an
error; the result arrives later as a system message.

Access legend: **open** = no approval · **approval** = admin must approve ·
**host-only** = never runnable from a container.

### groups — agent identities

| Command | Access | Notes |
|---|---|---|
| `groups list` | open | Filters `--name`, `--folder`, `--limit` |
| `groups get <id>` | open | |
| `groups create` | approval | Creates group **and** container config. Idempotent on `--folder`. `--folder` (slug, immutable), `--name`, `--timezone`, `--template <ref>` |
| `groups update <id>` | approval | Only `--name`. `folder` cannot change after creation. |
| `groups delete` | approval | FK-ordered cascade in one transaction: sessions, destinations, approvals, roles, memberships, wirings, container config. Does **not** kill running containers or delete `groups/<folder>/` on disk. `--id` |
| `groups restart` | approval | `--id`, `--rebuild`, `--message <text>`. From a container `--id` auto-fills and only that session restarts. |
| `groups config get` | open | `--id` |
| `groups config update` | approval | `--provider --model --effort --image-tag --assistant-name --max-messages-per-prompt --cli-scope --timezone`. Needs restart. |
| `groups config add-mcp-server` | approval | `--id --name --command [--args <json-array>] [--env <json-object>]`. Needs restart. |
| `groups config remove-mcp-server` | approval | `--id --name`. Needs restart. |
| `groups config add-package` | approval | `--id` and `--apt <pkg>` or `--npm <pkg>`. Needs `restart --rebuild`. |
| `groups config remove-package` | approval | `--id` and `--apt` or `--npm`. Needs `restart --rebuild`. |
| `groups config add-mount` | **host-only** | `--id --host <path> --container <path> [--ro]`. Allowlist-gated. Needs restart. |
| `groups config remove-mount` | **host-only** | `--id --host --container`. Needs restart. |

### messaging-groups — one chat on one platform

| Command | Access | Notes |
|---|---|---|
| `messaging-groups list` | open | Filters `--channel-type --platform-id --instance --name --is-group --unknown-sender-policy` |
| `messaging-groups get <id>` | open | |
| `messaging-groups create` | approval | Required `--channel-type --platform-id`. Optional `--instance` (defaults to channel type), `--name`, `--is-group 0\|1`, `--unknown-sender-policy strict\|request_approval\|public` |
| `messaging-groups update <id>` | approval | `--instance --name --is-group --unknown-sender-policy --denied-at` |
| `messaging-groups delete <id>` | approval | |
| `messaging-groups send` | approval | Inject a message as if a sender posted it, waking the wired agent (used for welcomes). `--channel-type --platform-id --text [--instance --sender-id --sender]` |

### wirings — chat ↔ agent

| Command | Access | Notes |
|---|---|---|
| `wirings list` | open | Filter by any engagement column |
| `wirings get <id>` | open | Under `group` CLI scope always targets the current chat |
| `wirings create` | approval | Chat by `--messaging-group-id` **or** `--channel-type --platform-id [--instance]`; agent by `--agent-group-id` **or** `--agent-group <folder>`. Then `--engage-mode --engage-pattern --session-mode --sender-scope --ignored-message-policy --threads --priority`. Idempotent on the pair. |
| `wirings update <id>` | approval | Same flags. From a container only `engage_mode` / `engage_pattern` may change. |
| `wirings delete <id>` | approval | |

### users · roles · members

| Command | Access | Notes |
|---|---|---|
| `users list` | open | Filters `--id --kind --display-name` |
| `users get <id>` | open | |
| `users create` | approval | Required `--id <channel>:<handle>` and `--kind`. Optional `--display-name` |
| `users update <id>` | approval | Only `--display-name` |
| `roles list` | open | Filters `--user-id --role --agent-group-id` |
| `roles grant` | approval | `--user --role owner\|admin [--group <id>]`. Owner is always global. |
| `roles revoke` | approval | `--user --role [--group]` |
| `members list` | open | Filters `--user-id --agent-group-id` |
| `members add` | approval | `--user --group`. Admins/owners are implicitly members. |
| `members remove` | approval | `--user --group` |

### destinations · policies

| Command | Access | Notes |
|---|---|---|
| `destinations list` | open | With resolved channel/title labels |
| `destinations add` | approval | `--agent-group-id --local-name --target-type channel\|agent --target-id` |
| `destinations remove` | approval | `--agent-group-id --local-name` |
| `policies list` | open | Filters `--from-agent-group-id --to-agent-group-id` |
| `policies set` | approval | `--from --to --approver <user-id>`. Directed; two rows to gate both ways. Operator-only. |
| `policies remove` | approval | `--from --to` |

### tasks — agents manage their own without approval

| Command | Access | Notes |
|---|---|---|
| `tasks list` | open | Run-history table. `--status pending\|paused --group --session --all` |
| `tasks get <id>` | open | Full prompt, script, run counts, failed runs, recent log. `--id` required. |
| `tasks create` | open | `--prompt` required, plus `--recurrence` **or** `--process-after`. Also `--name --script --group --dangerously-override-recurrence-limit` |
| `tasks update <id>` | open | `--prompt --process-after --recurrence --script` |
| `tasks run <id>` | open | One extra fire now; schedule untouched |
| `tasks pause <id>` / `resume <id>` | open | |
| `tasks cancel <id>` | open | `--all` = kill switch |
| `tasks delete <id>` | open | Hard-delete series + history |
| `tasks append-log` | open | `--msg` required. Log entry, not a message. `--id` auto-derives in a task run. |

### read-only surfaces

| Command | Notes |
|---|---|
| `sessions list` | Filters `--agent-group-id --messaging-group-id --thread-id --status active\|closed --container-status running\|idle\|stopped` |
| `sessions get <id>` | |
| `approvals list` | Filters `--status pending\|approved\|rejected\|expired --action --agent-group-id` |
| `approvals get <id>` | With payload |
| `dropped-messages list` | Filters `--reason --channel-type --platform-id --user-id` |
| `user-dms list` | Cold-DM route cache: (user, channel) → messaging group |

---

## 12. Troubleshooting

| Symptom | Look here |
|---|---|
| Anything at all | `logs/nanoclaw.error.log` first (delivery failures, crash-loop backoff), then `logs/nanoclaw.log` for the routing chain |
| Install failed | `logs/setup.log` for the sequence, then the named step under `logs/setup-steps/` |
| Message never reached the agent | `messages_in` in that session's `inbound.db`. Empty = routing dropped it → `ncl dropped-messages list` |
| Agent replied, nothing arrived | `messages_out` in `outbound.db`. Row present = delivery failed. No row = the agent produced nothing / never called `send_message`. |
| Reply "disappeared" | Missing destination row → `ncl destinations list --agent-group-id <id>` |
| Container keeps dying | Container logs are **lost** on exit (`--rm`). Reproduce with `pnpm run dev`. |
| Task did not fire | `ncl tasks get <id>` — check `failed_runs`, `next_run`, and whether it auto-paused after 8 failures |
| Task ran but sent nothing | The prompt must name a destination the agent holds, and must instruct it to call `send_message`. Final response text is logged, never delivered. |
| 401 from an API whose key is stored | Vault agent is in `selective` secret mode → `onecli agents list` |
| Wrong fire time | Group timezone override vs. install default → `ncl groups config get --id <id>` |

### Querying the databases

Use the in-tree wrapper, **not** the `sqlite3` CLI — host setup deliberately avoids
depending on that binary. Output matches `sqlite3 -list`.

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, name, folder FROM agent_groups"

pnpm exec tsx scripts/q.ts \
  data/v2-sessions/<group-id>/<session-id>/outbound.db \
  "SELECT seq, channel_type, platform_id, substr(content,1,120) FROM messages_out ORDER BY seq DESC LIMIT 10"
```

### Development

```bash
pnpm run dev / build / test / lint      # host (Node + pnpm, vitest)
./container/build.sh                     # rebuild the agent image

cd container/agent-runner && bun install # agent-runner is a SEPARATE Bun package tree
cd container/agent-runner && bun test    # imports from bun:test, NOT vitest
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

---

## 13. Invariants and gotchas

1. Config changes need `ncl groups restart`. Package changes also need `--rebuild`.
2. Never edit `groups/<folder>/CLAUDE.md` — regenerated every spawn. Use `instructions.prepend.md`.
3. A scheduled task has no chat. Name the destination in the prompt, and instruct it to call `send_message`.
4. `approval-pending` is a normal response, not an error.
5. Container logs vanish on exit. Reproduce with `pnpm run dev`.
6. "It ignored me" is usually `engage_mode: mention` in a group chat, or a missing membership.
7. "The reply vanished" is usually a missing destination row.
8. Memory is shared across every session in an agent group. Confidentiality boundaries need *separate agent groups*.
9. Frequent recurring tasks need a script gate, not the override flag.
10. Mount the narrowest directory possible, read-only. The blocklist checks the mount root only and does not descend.
11. **Timestamps:** every JS-written timestamp is `new Date().toISOString()` (ISO-8601 UTC, `Z`). Never `datetime('now')` — its naive shape is misparsed as local time. In pure SQL use `strftime('%Y-%m-%dT%H:%M:%fZ','now')`; wrap both sides of a comparison in `datetime()`. Display goes through `formatLocalTime` / `formatLocalStamp`; `--json`, DB values and operator logs stay ISO.
12. **Two runtimes.** Host = Node + pnpm. Container = Bun. No shared modules — only the session DBs. Never `pnpm install` inside `container/agent-runner/`. Never `bun install -g` for a CLI the agent invokes (bypasses the supply-chain policy — pin it in the Dockerfile's pnpm global-install block).
13. **bun:sqlite named params** need the `$` prefix in *both* SQL and JS keys (`.run({ $id: msg.id })`); it does not auto-strip like better-sqlite3 on the host.
14. `journal_mode=DELETE` on session DBs is load-bearing for cross-mount visibility. Read the comment block in `container/agent-runner/src/db/connection.ts` before changing pragmas.
15. **Supply chain:** host tree sets `minimumReleaseAge: 4320` (3 days). Never add to `minimumReleaseAgeExclude` (must pin an exact version, never a range) or `onlyBuiltDependencies` without explicit human sign-off. CI and container builds use `--frozen-lockfile`.
16. Container buildkit caches the build context aggressively — `--no-cache` alone does **not** invalidate `COPY` steps. Prune the builder for a genuinely clean rebuild.
17. **Contributing:** only security fixes, bug fixes and clear improvements land in trunk. Channels go on the `channels` branch, providers on `providers`, everything else is a self-contained skill. Read `CONTRIBUTING.md` before any PR.

---

## 14. Environment variables (`.env`)

Install-level knobs only. NanoClaw has no configuration files for *behavior*.

| Variable | Effect |
|---|---|
| `ASSISTANT_NAME` | Default assistant name. Defaults to `Andy`. |
| `TZ` | Install-wide timezone; groups may override |
| `DEFAULT_AGENT_PROVIDER` | Provider stamped onto **newly created** groups only; existing groups are never retroactively flipped |
| `ONECLI_URL`, `ONECLI_API_KEY` | Credential gateway location and key |
| `CONTAINER_CPU_LIMIT`, `CONTAINER_MEMORY_LIMIT`, `CONTAINER_PIDS_LIMIT` | Per-container caps. Empty = unbounded (default). |
| `CONTAINER_IMAGE`, `CONTAINER_IMAGE_BASE` | Override the per-checkout image tag |
| `NANOCLAW_EGRESS_LOCKDOWN`, `NANOCLAW_EGRESS_NETWORK` | Force all container egress through the credential gateway |
| `NANOCLAW_TEMPLATES_DIR` | Point the template library at another **local** directory. Never a URL. |
| `NANOCLAW_NO_DIAGNOSTICS=1` | Disable anonymous setup diagnostics — the only thing NanoClaw reports |
| `INSTALL_CJK_FONTS=true` | Include CJK fonts in the agent image (~200 MB). Without them, Chromium screenshots and PDFs containing CJK render as tofu. Requires a rebuild. |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` | Point at any Claude API-compatible endpoint |

---

## 15. Deeper reading in this repo

| Document | Covers |
|---|---|
| `docs/nanoclaw-handbook.html` | The same material as a navigable HTML page |
| `docs/architecture.md` | Full architecture writeup and the design rules that keep skills from conflicting |
| `docs/db.md`, `db-central.md`, `db-session.md` | Three-DB model, every table, cross-mount rules, seq parity |
| `docs/agent-runner-details.md` | Provider interface, poll loop, MCP tool internals, media handling, session resume |
| `docs/isolation-model.md` | The three isolation levels in full |
| `docs/scheduled-tasks.md` | Tasks, script gates, backoff |
| `docs/memory.md` | Memory tree and the OKF format |
| `docs/templates.md` | Authoring and stamping agent templates |
| `docs/skills-model.md`, `skill-guidelines.md`, `skill-directives.md` | Writing skills, the `nc:` directive grammar, the engine seam |
| `docs/build-and-runtime.md` | Node/Bun split, lockfiles, image build surface, CI invariants |
| `docs/provider-migration.md` | Switching a live group between providers; what carries over, rollback |
| `docs/hardened-image.md` | Opt in to pulling a prebuilt agent image |
| `CONTRIBUTING.md` | Accepted change types, the four skill types, pre-submission checklist |
