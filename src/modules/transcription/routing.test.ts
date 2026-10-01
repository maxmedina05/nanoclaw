/**
 * End-to-end guard for the transcription module's one coupling to core: the
 * router must hand interceptors the live event and route the content they
 * leave behind. If that breaks, transcription silently stops — this test
 * goes red instead.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { findSession } from '../../db/sessions.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import type { InboundEvent } from '../../channels/adapter.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-transcription' };
});

const TEST_DIR = '/tmp/nanoclaw-test-transcription';

function now() {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);

  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'chat-1',
    name: 'DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });

  process.env.WHISPER_URL = 'http://whisper.test:8100';
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: 'hola mundo' }), { status: 200 })),
  );
});

afterEach(async () => {
  delete process.env.WHISPER_URL;
  vi.unstubAllGlobals();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('transcription module through the router', () => {
  it('a routed voice note reaches the session with its transcript in text', async () => {
    await import('./index.js');
    const { routeInbound } = await import('../../router.js');

    const event: InboundEvent = {
      channelType: 'telegram',
      platformId: 'chat-1',
      threadId: null,
      message: {
        id: 'msg-voice-1',
        kind: 'chat',
        content: JSON.stringify({
          sender: 'User',
          text: '',
          attachments: [{ type: 'voice', name: 'voice.ogg', data: Buffer.from('fake-ogg').toString('base64') }],
        }),
        timestamp: now(),
      },
    };

    await routeInbound(event);

    const session = await findSession('mg-1', null);
    expect(session).toBeDefined();
    const db = new Database(inboundDbPath('ag-1', session!.id));
    const rows = db.prepare('SELECT content FROM messages_in').all() as Array<{ content: string }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('[Voice note transcript] hola mundo');
  });
});
