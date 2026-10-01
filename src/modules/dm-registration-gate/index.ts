/**
 * DM registration gate — only the owner or a global admin can self-register a
 * new DM chat.
 *
 * DMs are the abuse surface: anyone who finds the bot's handle can DM it and
 * page the owner with a registration card. Upstream sends a card for every
 * unknown chat; this module replaces upstream's channel-request gate so a DM
 * from anyone else stays a silent drop (the router already recorded it in
 * dropped_messages). The owner can still register them by hand with `ncl`
 * after reviewing `ncl dropped-messages list`.
 *
 * Group mentions are unchanged: onboarding the bot into a group chat is a
 * rarer, deliberate act and the card still needs the owner's approval.
 *
 * Replaces rather than wraps: the router holds a single gate slot, and this
 * module loads after the permissions module (see the modules barrel), so its
 * registration wins. The router logs one "Channel-request gate overwritten"
 * warning at startup — expected.
 */
import type { InboundEvent } from '../../channels/adapter.js';
import { log } from '../../log.js';
import { setChannelRequestGate } from '../../router.js';
import type { MessagingGroup } from '../../types.js';
import { requestChannelApproval } from '../permissions/channel-approval.js';
import { isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';

/**
 * The sender's user id, resolved the way the permissions module does
 * (top-level `senderId`/`sender`, or chat-sdk's nested `author.userId`).
 * Never creates a user row: owners and admins always exist already, and an
 * unknown sender is refused either way.
 */
export function senderUserId(event: InboundEvent): string | null {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(event.message.content) as Record<string, unknown>;
  } catch {
    return null;
  }
  const author =
    typeof content.author === 'object' && content.author !== null
      ? (content.author as Record<string, unknown>)
      : undefined;
  const raw =
    (typeof content.senderId === 'string' ? content.senderId : undefined) ??
    (typeof content.sender === 'string' ? content.sender : undefined) ??
    (typeof author?.userId === 'string' ? author.userId : undefined);
  if (!raw) return null;
  return raw.includes(':') ? raw : `${event.channelType}:${raw}`;
}

/** Whether this unknown chat may raise a registration card. */
export async function registrationAllowed(mg: MessagingGroup, event: InboundEvent): Promise<boolean> {
  const isGroup = event.message.isGroup ?? mg.is_group === 1;
  if (isGroup) return true;
  const userId = senderUserId(event);
  return !!userId && ((await isOwner(userId)) || (await isGlobalAdmin(userId)));
}

setChannelRequestGate(async (mg, event) => {
  if (!(await registrationAllowed(mg, event))) {
    log.info('Channel registration skipped — DM sender is not owner/admin, requires manual registration', {
      messagingGroupId: mg.id,
      userId: senderUserId(event),
    });
    return;
  }
  await requestChannelApproval({ messagingGroupId: mg.id, event });
});
