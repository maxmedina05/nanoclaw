/**
 * The DM registration gate, end to end through the router with the real
 * permissions module loaded first (barrel order): owner/admin DMs still raise
 * a registration card, stranger DMs are dropped silently, group mentions are
 * unchanged.
 */
import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import type { ChannelDefaults } from '../../channels/adapter.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
// Real barrel order: permissions registers its gate first, this module replaces it.
import '../permissions/index.js';
import { senderUserId } from './index.js';

const defaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};
registerChannelAdapter('telegram', { factory: () => null, defaults });

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: deliverMock }),
}));

vi.mock('../permissions/user-dm.js', () => ({
  ensureUserDm: vi.fn(async (userId: string) => {
    const { getDb } = await import('../../db/connection.js');
    return getDb().get(
      `SELECT mg.* FROM messaging_groups mg
         JOIN user_dms ud ON ud.messaging_group_id = mg.id
        WHERE ud.user_id = ?`,
      userId,
    );
  }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-dm-gate',
    GROUPS_DIR: '/tmp/nanoclaw-test-dm-gate/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-dm-gate';

function now() {
  return new Date().toISOString();
}

async function pendingCards(): Promise<number> {
  return (await getDb().get<{ c: number }>('SELECT COUNT(*) AS c FROM pending_channel_approvals'))!.c;
}

function event(platformId: string, senderId: string, isGroup: boolean) {
  return {
    channelType: 'telegram',
    platformId,
    threadId: null,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({ senderId, senderName: senderId, text: isGroup ? '@bot hello' : 'hello' }),
      timestamp: now(),
      isMention: true,
      isGroup,
    },
  };
}

beforeAll(async () => {
  await initChannelAdapters(() => ({ onInbound() {}, onInboundEvent() {}, onMetadata() {}, onAction() {} }));
});

afterAll(async () => {
  await teardownChannelAdapters();
});

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());

  await createAgentGroup({ id: 'ag-1', name: 'Andy', folder: 'andy', agent_provider: null, created_at: now() });
  await upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
  await grantRole({
    user_id: 'telegram:owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'telegram',
    platform_id: 'dm-owner',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await getDb().run(
    'INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, ?, ?, ?)',
    'telegram:owner',
    'telegram',
    'mg-dm-owner',
    now(),
  );
  deliverMock.mockClear();
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('DM registration gate', () => {
  it('drops a DM from a stranger: no card, no pending row', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(event('dm-stranger', 'stranger', false));
    await new Promise((r) => setTimeout(r, 50));

    expect(deliverMock).not.toHaveBeenCalled();
    expect(await pendingCards()).toBe(0);
  });

  it('still raises a card for a DM from the owner', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(event('dm-new-owner-chat', 'owner', false));
    await vi.waitFor(() => expect(deliverMock).toHaveBeenCalledTimes(1));
    expect(await pendingCards()).toBe(1);
  });

  it('leaves group mentions alone: a stranger mentioning the bot still raises a card', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(event('group-1', 'stranger', true));
    await vi.waitFor(() => expect(deliverMock).toHaveBeenCalledTimes(1));
    expect(await pendingCards()).toBe(1);
  });
});

describe('senderUserId', () => {
  const base = { channelType: 'telegram', platformId: 'p', threadId: null };
  const withContent = (content: unknown) =>
    ({ ...base, message: { id: 'm', kind: 'chat', content: JSON.stringify(content), timestamp: now() } }) as never;

  it('prefixes a bare handle with the channel type', () => {
    expect(senderUserId(withContent({ senderId: '123' }))).toBe('telegram:123');
  });

  it('reads chat-sdk nested author.userId', () => {
    expect(senderUserId(withContent({ author: { userId: '456' } }))).toBe('telegram:456');
  });

  it('keeps an already-namespaced id and returns null when there is no sender', () => {
    expect(senderUserId(withContent({ senderId: 'slack:U1' }))).toBe('slack:U1');
    expect(senderUserId(withContent({ text: 'hi' }))).toBeNull();
  });
});
