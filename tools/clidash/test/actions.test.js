// clidash-local: tests for the NanoClaw write panel (actions.js + its routes).
// The load-bearing assertions are the negative ones — a rejected request must
// not reach exec, which we prove by reading the stub's invocation log.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';

const STUB = fileURLToPath(new URL('./fixtures/stub-ncl-actions.js', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'clidash-actions-'));
const TOKEN = 'test-token-abc';

after(() => rmSync(tmp, { recursive: true, force: true }));

/** A stand-in Ollama: one tool-capable model, one without tools. */
async function withOllama(fn) {
  const server = createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        models: [
          { name: 'good:9b', size: 6.6e9, capabilities: ['completion', 'tools'], details: { context_length: 131072 } },
          { name: 'no-tools:8b', size: 5.2e9, capabilities: ['completion', 'thinking'] },
        ],
      }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

let logSeq = 0;
async function withApp(ollamaUrl, { token = TOKEN, restartFail = false } = {}, fn) {
  const countFile = join(tmp, `calls-${++logSeq}.log`);
  const config = {
    port: 0,
    bind: '127.0.0.1',
    execTimeoutMs: 5000,
    clis: {
      ncl: {
        bin: STUB,
        resources: ['groups'],
        list: ['{resource}', 'list', '--json'],
        output: 'json',
        unwrap: 'data',
        env: {
          STUB_COUNT_FILE: countFile,
          STUB_OLLAMA_URL: ollamaUrl,
          ...(restartFail ? { STUB_RESTART_FAIL: '1' } : {}),
        },
      },
    },
    actions: { cli: 'ncl', token, execTimeoutMs: 5000 },
  };
  const server = createApp(config);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, () => (existsSync(countFile) ? readFileSync(countFile, 'utf8').trim().split('\n').filter(Boolean) : []));
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const auth = (token = TOKEN) => ({ 'X-Clidash-Token': token, 'Content-Type': 'application/json' });

test('/api/actions/status: advertises the panel and that a token is required', async () => {
  await withOllama(async (ollama) => {
    await withApp(ollama, {}, async (base) => {
      const body = await (await fetch(`${base}/api/actions/status`)).json();
      assert.equal(body.enabled, true);
      assert.equal(body.tokenRequired, true);
    });
  });
});

test('models: only tool-capable models are offered', async () => {
  await withOllama(async (ollama) => {
    await withApp(ollama, {}, async (base) => {
      const res = await fetch(`${base}/api/actions/models?group=ag-test-1`, { headers: auth() });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ollama, true);
      assert.deepEqual(body.models.map((m) => m.name), ['good:9b']);
      assert.equal(body.current, 'old-model:1b');
    });
  });
});

test('models: a group with no base-url override reports ollama:false', async () => {
  await withOllama(async (ollama) => {
    await withApp(ollama, {}, async (base) => {
      const body = await (await fetch(`${base}/api/actions/models?group=ag-test-2`, { headers: auth() })).json();
      assert.equal(body.ollama, false);
      assert.deepEqual(body.models, []);
    });
  });
});

test('models: an unknown group is rejected as 404', async () => {
  await withOllama(async (ollama) => {
    await withApp(ollama, {}, async (base) => {
      const res = await fetch(`${base}/api/actions/models?group=ag-nope`, { headers: auth() });
      assert.equal(res.status, 404);
    });
  });
});

test('apply: happy path runs config update then restart, in that order', async () => {
  await withOllama(async (ollama) => {
    await withApp(ollama, {}, async (base, calls) => {
      const res = await fetch(`${base}/api/actions/apply`, {
        method: 'POST', headers: auth(), body: JSON.stringify({ group: 'ag-test-1', model: 'good:9b' }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.deepEqual(body.steps.map((s) => s.step), ['set-model', 'restart']);
      const writes = calls().filter((c) => c.includes('config update') || c.startsWith('groups restart'));
      assert.deepEqual(writes, [
        'groups config update --id ag-test-1 --model good:9b',
        'groups restart --id ag-test-1',
      ]);
    });
  });
});

test('apply: a model the server did not offer is refused before any write', async () => {
  await withOllama(async (ollama) => {
    await withApp(ollama, {}, async (base, calls) => {
      const res = await fetch(`${base}/api/actions/apply`, {
        method: 'POST', headers: auth(), body: JSON.stringify({ group: 'ag-test-1', model: 'no-tools:8b' }),
      });
      assert.equal(res.status, 400);
      assert.equal(calls().some((c) => c.includes('config update')), false);
    });
  });
});

test('apply: a Claude-backed group cannot have its model set from here', async () => {
  await withOllama(async (ollama) => {
    await withApp(ollama, {}, async (base, calls) => {
      const res = await fetch(`${base}/api/actions/apply`, {
        method: 'POST', headers: auth(), body: JSON.stringify({ group: 'ag-test-2', model: 'good:9b' }),
      });
      assert.equal(res.status, 400);
      assert.equal(calls().some((c) => c.includes('config update')), false);
    });
  });
});

test('apply: a failed restart still reports the model as saved', async () => {
  await withOllama(async (ollama) => {
    await withApp(ollama, { restartFail: true }, async (base) => {
      const res = await fetch(`${base}/api/actions/apply`, {
        method: 'POST', headers: auth(), body: JSON.stringify({ group: 'ag-test-1', model: 'good:9b' }),
      });
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.match(body.error, /Model saved/);
      assert.deepEqual(body.steps.map((s) => s.step), ['set-model']);
    });
  });
});

test('token: a wrong or missing token blocks reads and writes without exec', async () => {
  await withOllama(async (ollama) => {
    await withApp(ollama, {}, async (base, calls) => {
      const noToken = await fetch(`${base}/api/actions/models?group=ag-test-1`);
      assert.equal(noToken.status, 401);

      const badWrite = await fetch(`${base}/api/actions/apply`, {
        method: 'POST', headers: auth('wrong'), body: JSON.stringify({ group: 'ag-test-1', model: 'good:9b' }),
      });
      assert.equal(badWrite.status, 401);
      assert.deepEqual(calls(), []);
    });
  });
});

test('group ids carrying path or shell characters are rejected', async () => {
  await withOllama(async (ollama) => {
    await withApp(ollama, {}, async (base, calls) => {
      for (const bad of ['../etc', 'ag test', 'ag;rm -rf /', 'ag/../x']) {
        const res = await fetch(`${base}/api/actions/models?group=${encodeURIComponent(bad)}`, { headers: auth() });
        assert.equal(res.status, 400, `expected 400 for ${bad}`);
      }
      assert.deepEqual(calls(), []);
    });
  });
});

test('the rest of the dashboard stays GET-only', async () => {
  await withOllama(async (ollama) => {
    await withApp(ollama, {}, async (base) => {
      for (const path of ['/api/clis', '/api/r/ncl/groups', '/']) {
        const res = await fetch(`${base}${path}`, { method: 'POST', headers: auth() });
        assert.equal(res.status, 405, `expected 405 for POST ${path}`);
      }
    });
  });
});

test('actions disabled: no config section means no write surface at all', async () => {
  await withOllama(async (ollama) => {
    const config = {
      port: 0, bind: '127.0.0.1',
      clis: { ncl: { bin: STUB, resources: ['groups'], list: ['{resource}', 'list', '--json'], output: 'json', unwrap: 'data' } },
    };
    const server = createApp(config);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const status = await (await fetch(`${base}/api/actions/status`)).json();
      assert.equal(status.enabled, false);
      const res = await fetch(`${base}/api/actions/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group: 'ag-test-1', model: 'good:9b' }),
      });
      assert.equal(res.status, 404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
