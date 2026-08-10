import { readEnvFile } from './env.js';
import { log } from './log.js';

/**
 * Speech-to-text for inbound audio attachments, via an OpenAI-compatible
 * `/v1/audio/transcriptions` endpoint (Speaches / faster-whisper-server).
 *
 * Runs host-side, before `writeSessionMessage`, for three reasons:
 *
 *   1. The container reaches the network through the OneCLI gateway proxy and
 *      a per-group `blocked_hosts` list. Transcribing here needs no per-group
 *      `NO_PROXY` entry and works uniformly for every agent group.
 *   2. Small local models (a 4B-class Ollama model, say) are unreliable at
 *      deciding to call a `transcribe` tool. Host-side means the text is
 *      simply present and no tool call is needed.
 *   3. The audio bytes are already in hand as base64 on the inbound event, so
 *      nothing has to be re-read from disk.
 *
 * Fail-open by construction: any error, timeout, or unset `WHISPER_URL`
 * leaves the message untouched and routing continues. The agent then sees the
 * attachment exactly as it did before this module existed. A transcription
 * backend that is down (a laptop that went to sleep) degrades the feature,
 * never the assistant.
 */

const envConfig = readEnvFile(['WHISPER_URL', 'WHISPER_MODEL', 'WHISPER_TIMEOUT_MS', 'WHISPER_MAX_BYTES']);

function cfg(key: string, fallback = ''): string {
  return process.env[key] || envConfig[key] || fallback;
}

const DEFAULT_MODEL = 'deepdml/faster-whisper-large-v3-turbo-ct2';
const DEFAULT_TIMEOUT_MS = 8000;
// Telegram caps voice notes well below this; the limit exists so a malicious
// or malformed attachment can't tie up the router uploading megabytes.
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/** Coarse media-class set by the channel bridges (see attachment-naming.ts). */
const AUDIO_TYPES = new Set(['voice', 'audio']);
const AUDIO_EXTS = new Set(['ogg', 'oga', 'opus', 'mp3', 'wav', 'm4a', 'mp4a', 'flac', 'webm']);

export function transcriptionEnabled(): boolean {
  return cfg('WHISPER_URL') !== '';
}

/**
 * Is this attachment audio we should try to transcribe?
 *
 * Checks the coarse `type` first (Telegram voice notes arrive with no MIME),
 * then `mimeType`, then the filename extension — the same precedence
 * `deriveAttachmentName` uses, so the two agree on what an audio file is.
 */
export function isTranscribable(att: Record<string, unknown>): boolean {
  if (typeof att.type === 'string' && AUDIO_TYPES.has(att.type.toLowerCase())) return true;

  const mime = att.mimeType ?? att.mime_type ?? att.contentType;
  if (typeof mime === 'string' && mime.split(';')[0].trim().toLowerCase().startsWith('audio/')) return true;

  const name = att.name ?? att.filename;
  if (typeof name === 'string') {
    const ext = name.split('.').pop()?.toLowerCase();
    if (ext && AUDIO_EXTS.has(ext)) return true;
  }
  return false;
}

/**
 * POST one audio buffer to the transcription endpoint. Returns the text, or
 * null on any failure — callers must treat null as "no transcript available"
 * rather than as an error to propagate.
 */
export async function transcribeAudio(bytes: Buffer, filename: string): Promise<string | null> {
  const base = cfg('WHISPER_URL');
  if (!base) return null;

  const maxBytes = Number(cfg('WHISPER_MAX_BYTES')) || DEFAULT_MAX_BYTES;
  if (bytes.length > maxBytes) {
    log.warn('Audio attachment too large to transcribe', { filename, bytes: bytes.length, maxBytes });
    return null;
  }

  const timeoutMs = Number(cfg('WHISPER_TIMEOUT_MS')) || DEFAULT_TIMEOUT_MS;
  const model = cfg('WHISPER_MODEL', DEFAULT_MODEL);
  const url = `${base.replace(/\/+$/, '')}/v1/audio/transcriptions`;

  try {
    const form = new FormData();
    // Copy into a fresh Uint8Array — a Buffer is a view onto a possibly larger
    // pooled ArrayBuffer, and Blob would otherwise capture the whole pool.
    form.append('file', new Blob([new Uint8Array(bytes)]), filename);
    form.append('model', model);

    const res = await fetch(url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      log.warn('Transcription request failed', { url, status: res.status, filename });
      return null;
    }

    const body = (await res.json()) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    return text || null;
  } catch (err) {
    // Includes the timeout path (AbortError) and a sleeping/unreachable host.
    log.warn('Transcription unavailable, continuing without it', { url, filename, err });
    return null;
  }
}

/**
 * Transcribe every audio attachment carrying inline base64 `data` and stamp
 * the result onto the attachment as `transcript`.
 *
 * Takes and returns the serialized message content so the caller can hand the
 * result straight to `writeSessionMessage`. Returns the input unchanged when
 * transcription is disabled, the content isn't JSON, there is no audio, or
 * every attempt failed — so this is safe to call unconditionally.
 */
export async function attachTranscripts(contentStr: string): Promise<string> {
  if (!transcriptionEnabled()) return contentStr;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contentStr);
  } catch {
    return contentStr;
  }

  const attachments = parsed.attachments as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(attachments) || attachments.length === 0) return contentStr;

  const targets = attachments.filter((a) => typeof a.data === 'string' && isTranscribable(a));
  if (targets.length === 0) return contentStr;

  // Concurrent: a message can carry several voice notes, and they are
  // independent. The per-request timeout bounds the whole batch.
  const results = await Promise.all(
    targets.map(async (att) => {
      const name = typeof att.name === 'string' ? att.name : 'audio';
      let bytes: Buffer;
      try {
        bytes = Buffer.from(att.data as string, 'base64');
      } catch {
        return false;
      }
      const text = await transcribeAudio(bytes, name);
      if (!text) return false;
      att.transcript = text;
      return true;
    }),
  );

  if (!results.some(Boolean)) return contentStr;

  log.info('Transcribed inbound audio', {
    attachments: targets.length,
    transcribed: results.filter(Boolean).length,
  });
  return JSON.stringify(parsed);
}
