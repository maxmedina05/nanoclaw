import type { Migration } from './index.js';

/**
 * Per-agent-group container env overrides on `container_configs`.
 *
 * NULL = no overrides, matching pre-migration behavior for every existing row —
 * deliberately no backfill.
 *
 * Exists so one agent group can be routed to a different model endpoint than
 * another (e.g. a local Ollama box) without redirecting the whole install.
 * `env` is JSON Record<string,string>.
 *
 * `blocked_hosts` (JSON string[]) is kept so fresh installs match installs that
 * applied this migration before it was rebased onto the session-driver seam;
 * nothing reads it any more. Blocking a host for one group is now a OneCLI
 * per-agent rule (`onecli rules create --action block --agent-id ...`).
 *
 * The name is the applied identity — installs that ran this as 022 must not
 * run it again, so it stays `container-config-env`.
 */
export const migration026: Migration = {
  version: 26,
  name: 'container-config-env',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN env TEXT;`);
    await db.exec(`ALTER TABLE container_configs ADD COLUMN blocked_hosts TEXT;`);
  },
};
