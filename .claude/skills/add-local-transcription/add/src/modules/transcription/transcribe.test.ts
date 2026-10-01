import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { attachTranscripts, isTranscribable, transcriptionEnabled } from './transcribe.js';

// transcribe.ts also reads WHISPER_* from the install's .env. Isolate the
// tests from it, or a configured install fails the "unset" cases.
vi.mock('../../env.js', () => ({ readEnvFile: () => ({}) }));

/**
 * The contract these lock down is fail-open: every failure path must return
 * the original content untouched so routing continues. A regression here
 * doesn't lose a transcript, it wedges inbound messages.
 */

const ORIGINAL_URL = process.env.WHISPER_URL;

function withAudio(data = 'AAAA'): string {
  return JSON.stringify({
    text: '',
    attachments: [{ type: 'voice', name: 'voice.ogg', data }],
  });
}

beforeEach(() => {
  process.env.WHISPER_URL = 'http://whisper.test:8100';
  process.env.WHISPER_MODEL = 'test-model';
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.WHISPER_URL;
  else process.env.WHISPER_URL = ORIGINAL_URL;
  delete process.env.WHISPER_MODEL;
  vi.restoreAllMocks();
});

describe('isTranscribable', () => {
  it('accepts the coarse media-class Telegram voice notes arrive with', () => {
    expect(isTranscribable({ type: 'voice' })).toBe(true);
    expect(isTranscribable({ type: 'audio' })).toBe(true);
  });

  it('accepts an audio mime even with parameters', () => {
    expect(isTranscribable({ mimeType: 'audio/ogg; codecs=opus' })).toBe(true);
  });

  it('falls back to the filename extension', () => {
    expect(isTranscribable({ name: 'note.m4a' })).toBe(true);
  });

  it('rejects non-audio attachments', () => {
    expect(isTranscribable({ type: 'photo', name: 'cat.jpg' })).toBe(false);
    expect(isTranscribable({ mimeType: 'application/pdf', name: 'doc.pdf' })).toBe(false);
    expect(isTranscribable({})).toBe(false);
  });
});

describe('transcriptionEnabled', () => {
  it('is off when WHISPER_URL is unset', () => {
    delete process.env.WHISPER_URL;
    expect(transcriptionEnabled()).toBe(false);
  });
});

describe('attachTranscripts', () => {
  it('stamps the transcript onto the attachment', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: '  hola mundo  ' }) }));

    const out = await attachTranscripts(withAudio());
    expect(JSON.parse(out).attachments[0].transcript).toBe('hola mundo');
  });

  it('posts to the OpenAI-compatible path with the configured model', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'x' }) });
    vi.stubGlobal('fetch', fetchMock);

    await attachTranscripts(withAudio());

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://whisper.test:8100/v1/audio/transcriptions');
    expect((init.body as FormData).get('model')).toBe('test-model');
  });

  it('is a no-op when transcription is disabled', async () => {
    delete process.env.WHISPER_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const input = withAudio();
    expect(await attachTranscripts(input)).toBe(input);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves content untouched when the backend errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));

    const input = withAudio();
    expect(await attachTranscripts(input)).toBe(input);
  });

  it('leaves content untouched when the backend is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const input = withAudio();
    expect(await attachTranscripts(input)).toBe(input);
  });

  it('leaves content untouched when the response has no text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: '   ' }) }));

    const input = withAudio();
    expect(await attachTranscripts(input)).toBe(input);
  });

  it('ignores non-audio attachments and plain text messages', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const photo = JSON.stringify({ attachments: [{ type: 'photo', name: 'cat.jpg', data: 'AAAA' }] });
    expect(await attachTranscripts(photo)).toBe(photo);

    const plain = JSON.stringify({ text: 'hello' });
    expect(await attachTranscripts(plain)).toBe(plain);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips audio that was already written to disk (no inline data)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const staged = JSON.stringify({ attachments: [{ type: 'voice', name: 'v.ogg', localPath: 'inbox/1/v.ogg' }] });
    expect(await attachTranscripts(staged)).toBe(staged);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('survives content that is not JSON', async () => {
    expect(await attachTranscripts('not json at all')).toBe('not json at all');
  });

  it('transcribes several voice notes in one message', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ text: 'uno' }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ text: 'dos' }) }),
    );

    const input = JSON.stringify({
      attachments: [
        { type: 'voice', name: 'a.ogg', data: 'AAAA' },
        { type: 'voice', name: 'b.ogg', data: 'BBBB' },
      ],
    });
    const out = JSON.parse(await attachTranscripts(input));
    expect(out.attachments.map((a: { transcript: string }) => a.transcript)).toEqual(['uno', 'dos']);
  });

  it('keeps the surviving transcript when one of two fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ text: 'dos' }) }),
    );

    const input = JSON.stringify({
      attachments: [
        { type: 'voice', name: 'a.ogg', data: 'AAAA' },
        { type: 'voice', name: 'b.ogg', data: 'BBBB' },
      ],
    });
    const out = JSON.parse(await attachTranscripts(input));
    expect(out.attachments[0].transcript).toBeUndefined();
    expect(out.attachments[1].transcript).toBe('dos');
  });

  it('refuses oversized audio rather than uploading it', async () => {
    process.env.WHISPER_MAX_BYTES = '4';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // 8 raw bytes once base64-decoded, over the 4-byte cap.
    const input = withAudio(Buffer.from('AAAAAAAA').toString('base64'));
    expect(await attachTranscripts(input)).toBe(input);
    expect(fetchMock).not.toHaveBeenCalled();

    delete process.env.WHISPER_MAX_BYTES;
  });
});
