/**
 * Transcription module — speech-to-text for inbound voice notes.
 *
 * Registers a pre-route message interceptor that rewrites the event's content
 * in place (transcript stamped on the attachment and appended to `text`) and
 * never claims the message, so routing continues with the transcribed content.
 * Running before routing also means one transcription per inbound message,
 * not one per wired agent.
 *
 * This leans on the router handing interceptors the live event object. If
 * that ever changes, transcription stops (fail-open) — routing.test.ts goes
 * red first.
 */
import { registerMessageInterceptor } from '../../router.js';
import { attachTranscripts, transcriptionEnabled } from './transcribe.js';

registerMessageInterceptor(async (event) => {
  if (!transcriptionEnabled()) return false;
  event.message.content = await attachTranscripts(event.message.content);
  return false;
});
