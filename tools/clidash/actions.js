// clidash actions — the ONLY write path in this dashboard.
//
// Security model, deliberately narrower than the read side:
//   * No argv templates. Every command is a hard-coded array in ACTIONS below;
//     nothing from the request is ever concatenated into a command name or flag.
//   * The two request-supplied values are a group id and a model name. The group
//     must appear in `ncl groups list --json`; the model must appear in the
//     freshly-fetched Ollama tag list for THAT group. The client's dropdown is
//     never trusted — membership is re-checked here at apply time.
//   * execFile, never a shell (same as the read side).
//   * When `actions.token` is configured, every request must carry it in the
//     X-Clidash-Token header. That header also forces a CORS preflight which the
//     server never answers, so cross-origin POSTs die before reaching us.
//
// Writes are inert until the container restarts, so `apply` always runs both
// `config update` and `restart` and reports each step separately.

import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';

// ncl argv, fully literal. `{id}` / `{model}` are positional placeholders that
// are replaced only after validation, and only ever as a whole argv element.
const ACTIONS = {
  'set-model': (id, model) => ['groups', 'config', 'update', '--id', id, '--model', model],
  restart: (id) => ['groups', 'restart', '--id', id],
};

// ncl group ids: "ag-<uuid>" or "ag-<epoch>-<suffix>". No slashes, no metas.
const GROUP_ID_RE = /^[A-Za-z0-9:_.-]+$/;

/** Constant-time string compare that tolerates length mismatch. */
function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function createActions(config) {
  const cfg = config.actions;
  const enabled = !!cfg;
  const cliName = cfg?.cli ?? 'ncl';
  const cliCfg = config.clis?.[cliName];
  // Writes take two tsx cold starts plus a container kill — far longer than the
  // 10s the read tabs are tuned for.
  const timeout = cfg?.execTimeoutMs ?? 60_000;
  const modelsTimeoutMs = cfg?.modelsTimeoutMs ?? 8_000;

  function err(status, message) {
    const e = new Error(message);
    e.statusCode = status;
    return e;
  }

  /** True when the request may perform actions. */
  function authorize(req) {
    if (!enabled) throw err(404, 'Actions are not enabled on this dashboard.');
    if (!cliCfg) throw err(500, `actions.cli "${cliName}" is not a configured CLI.`);
    if (!cfg.token) return; // explicitly unauthenticated — network is the boundary
    const supplied = req.headers['x-clidash-token'];
    if (!tokensMatch(typeof supplied === 'string' ? supplied : '', cfg.token)) {
      throw err(401, 'Missing or invalid X-Clidash-Token.');
    }
  }

  function run(args, label) {
    return new Promise((resolvePromise, rejectPromise) => {
      execFile(cliCfg.bin, args, {
        cwd: cliCfg.cwd,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, ...cliCfg.env },
      }, (error, stdout, stderr) => {
        if (error) {
          const timedOut = error.killed || error.signal === 'SIGTERM';
          rejectPromise(new Error(timedOut
            ? `${label} timed out after ${timeout}ms`
            : `${label} failed: ${stderr.trim() || error.message}`));
          return;
        }
        resolvePromise((stdout + stderr).trim());
      });
    });
  }

  /** Every agent group id ncl knows about. The gate for any {id} we accept. */
  async function knownGroupIds() {
    const out = await run(['groups', 'list', '--json'], 'ncl groups list');
    const parsed = JSON.parse(out);
    const rows = Array.isArray(parsed) ? parsed : (parsed.data ?? []);
    return new Set(rows.map((r) => r.id));
  }

  async function assertKnownGroup(groupId) {
    if (!GROUP_ID_RE.test(groupId ?? '')) throw err(400, 'Invalid group id.');
    if (!(await knownGroupIds()).has(groupId)) throw err(404, `Unknown agent group "${groupId}".`);
  }

  /** The group's container config, used only to derive its model endpoint. */
  async function groupConfig(groupId) {
    const out = await run(['groups', 'config', 'get', '--id', groupId, '--json'], 'ncl groups config get');
    const parsed = JSON.parse(out);
    return parsed.data ?? parsed;
  }

  /**
   * Models this group can actually be switched to.
   *
   * A group is "ollama-routed" when its container env overrides
   * ANTHROPIC_BASE_URL. Only those get a dropdown: a Claude-backed group's model
   * set is not enumerable from here, so we return ollama:false and refuse to
   * write. Models without the `tools` capability are excluded — they load fine
   * and then fail as agents, which is the trap this panel exists to prevent.
   */
  async function listModels(groupId) {
    await assertKnownGroup(groupId);
    const conf = await groupConfig(groupId);
    const baseUrl = conf?.env?.ANTHROPIC_BASE_URL ?? null;
    if (!baseUrl) {
      return { ollama: false, baseUrl: null, current: conf?.model ?? null, models: [] };
    }
    let payload;
    try {
      const res = await fetch(new URL('/api/tags', baseUrl), {
        signal: AbortSignal.timeout(modelsTimeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      payload = await res.json();
    } catch (e) {
      throw err(502, `Could not reach the model server at ${baseUrl}: ${e.message}`);
    }
    const models = (payload.models ?? [])
      .filter((m) => (m.capabilities ?? []).includes('tools'))
      .map((m) => ({
        name: m.name,
        sizeGb: m.size ? Number((m.size / 1e9).toFixed(1)) : null,
        capabilities: m.capabilities ?? [],
        contextLength: m.details?.context_length ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { ollama: true, baseUrl, current: conf?.model ?? null, models };
  }

  /**
   * Set a model and restart. Two steps, reported independently: a successful
   * config write followed by a failed restart still leaves the new model saved,
   * and the operator needs to know that.
   */
  async function apply({ group, model, restart = true }) {
    const available = await listModels(group); // re-validates the group
    if (!available.ollama) {
      throw err(400, 'This group is not routed to a local model server, so its model cannot be set from here.');
    }
    if (typeof model !== 'string' || !available.models.some((m) => m.name === model)) {
      throw err(400, `Model "${model}" is not an available tool-capable model for this group.`);
    }

    const steps = [];
    const setArgs = ACTIONS['set-model'](group, model);
    steps.push({ step: 'set-model', command: `ncl ${setArgs.join(' ')}`, output: await run(setArgs, 'ncl groups config update') });

    if (restart) {
      const restartArgs = ACTIONS.restart(group);
      try {
        steps.push({ step: 'restart', command: `ncl ${restartArgs.join(' ')}`, output: await run(restartArgs, 'ncl groups restart') });
      } catch (e) {
        return {
          ok: false,
          model,
          steps,
          error: `Model saved, but the restart failed: ${e.message}`,
        };
      }
    }
    return { ok: true, model, steps };
  }

  return { enabled, tokenRequired: !!cfg?.token, authorize, listModels, apply };
}
