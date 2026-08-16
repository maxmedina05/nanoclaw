#!/usr/bin/env node
// Stub ncl for the actions (write-path) tests. Impersonates the four commands
// actions.js is allowed to run and records every invocation so a test can
// assert that a rejected request never reached exec.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const join = args.join(' ');

if (process.env.STUB_COUNT_FILE) appendFileSync(process.env.STUB_COUNT_FILE, join + '\n');

const envelope = (data) => JSON.stringify({ id: 'req-1', ok: true, data });

if (join === 'groups list --json') {
  process.stdout.write(envelope([
    { id: 'ag-test-1', name: 'Local', folder: 'local' },
    { id: 'ag-test-2', name: 'Cloud', folder: 'cloud' },
  ]) + '\n');
  process.exit(0);
}

if (args[0] === 'groups' && args[1] === 'config' && args[2] === 'get') {
  const id = args[args.indexOf('--id') + 1];
  // ag-test-2 has no base-url override → stands in for a Claude-backed group.
  const env = id === 'ag-test-2' ? {} : { ANTHROPIC_BASE_URL: process.env.STUB_OLLAMA_URL };
  process.stdout.write(envelope({ agent_group_id: id, model: 'old-model:1b', env }) + '\n');
  process.exit(0);
}

if (args[0] === 'groups' && args[1] === 'config' && args[2] === 'update') {
  process.stdout.write('Updated container config.\n');
  process.exit(0);
}

if (args[0] === 'groups' && args[1] === 'restart') {
  if (process.env.STUB_RESTART_FAIL) {
    process.stderr.write('restart exploded\n');
    process.exit(3);
  }
  process.stdout.write('Container killed; will respawn on next message.\n');
  process.exit(0);
}

process.stderr.write(`stub-ncl-actions: unexpected argv: ${join}\n`);
process.exit(9);
