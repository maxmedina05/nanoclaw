---
name: add-local-transcription
description: Add speech-to-text for inbound voice notes via a self-hosted Whisper server (whisper.cpp on a Mac, or Speaches on a Linux GPU box). The host transcribes audio before the agent sees it, so every agent, including small local models, gets the words as text. Use when voice notes reach agents as unreadable audio files, or to set up, move, or verify the Whisper server.
---

# /add-local-transcription: voice notes become text

Claude (and most local models) can't listen to audio. Without this, a Telegram
voice note reaches the agent as an `.ogg` file it can't open, and the words are
lost. This skill installs a host module that sends inbound audio to a Whisper
server you run, then appends the transcript to the message text:

```
[Voice note transcript] ¿Puedes entender los audios?
[voice: attachment-….ogg — saved to /workspace/inbox/<msgId>/attachment-….ogg]
```

## How it works

- **Host-side, before routing.** A pre-route message interceptor
  (`src/modules/transcription/`) transcribes the audio and rewrites the event
  content. One Whisper call per message, whatever the number of wired agents.
- **No agent-runner change.** The transcript goes into the message's own `text`,
  which the container formatter already renders and XML-escapes. The prefix
  keeps a spoken "/clear" from parsing as a command.
- **Fail-open.** `WHISPER_URL` unset, server down, HTTP error, timeout,
  oversized audio: the message continues unchanged and the agent sees the audio
  file as before. `logs/nanoclaw.error.log` gets
  `Transcription unavailable, continuing without it`.
- **Why not a container tool:** small local models don't call tools reliably,
  container egress goes through the credential gateway (each group would need a
  `NO_PROXY` entry), and the audio bytes are already on the host as base64.

Side effects worth knowing:

- A spoken word now counts for engage patterns in group chats.
- A stranger's voice note is transcribed before being dropped (one Whisper call).

The only core touch is one import line in the modules barrel.

## Steps

### 1. Set up a Whisper server

Any OpenAI-compatible `POST /v1/audio/transcriptions` endpoint that returns
`{"text": "..."}` works. Two tested setups are in
[references/whisper-server.md](references/whisper-server.md):

- **Mac with Apple Silicon (recommended):** whisper.cpp on Metal. ~750 MB RAM,
  ~0.6 s per short note. This install runs it on the Mac mini.
- **Linux box with an NVIDIA GPU:** Speaches in Docker Compose.

Confirm it answers from the NanoClaw host before going further, using a real
voice note (it exercises the opus decode path):

```bash
curl -sS -F file=@data/v2-sessions/<group>/<session>/inbox/<msg>/<file>.ogg -F model=x <WHISPER_URL>/v1/audio/transcriptions
```

Expected: `{"text":" ...your words..."}`.

### 2. Copy the module into place

```bash
cp -R .claude/skills/add-local-transcription/add/src/modules/transcription src/modules/transcription
```

### 3. Register it in the modules barrel

Add this line to `src/modules/index.ts`, **above** `import './community-portal/index.js';`
(skip if already present):

```typescript
import './transcription/index.js';
```

Above, not appended: upstream's community-portal test expects the portal to be
the last module that registers a host-start callback. This module registers none,
but keeping your modules together above the portal avoids surprises.

### 4. Configure the host

In `.env`:

| Key | Default | Meaning |
|-----|---------|---------|
| `WHISPER_URL` | *(unset)* | Server base URL, no path. **Unset disables the feature.** |
| `WHISPER_TIMEOUT_MS` | `8000` | Per-request timeout. Use `20000`: the first request after a server restart can take ~15 s while the GPU warms up. |
| `WHISPER_MODEL` | `deepdml/faster-whisper-large-v3-turbo-ct2` | Model id sent per request. Speaches needs it; whisper.cpp ignores it. |
| `WHISPER_MAX_BYTES` | `26214400` | Refuse audio larger than this rather than uploading it. |

This install:

```
WHISPER_URL=http://100.98.48.59:8100
WHISPER_TIMEOUT_MS=20000
```

These are read once at host start.

### 5. Build, test, stamp

```bash
pnpm run build
pnpm exec vitest run src/modules/transcription
pnpm exec tsx scripts/upgrade-state.ts set
```

`routing.test.ts` routes a voice note through the real router and checks the
transcript lands in `inbound.db`. It guards the module's one coupling to core:
interceptors must receive the live event object. If upstream ever passes a copy,
this test fails rather than transcription silently stopping.

The stamp is needed because NanoClaw 2.4's upgrade tripwire refuses to start on
a commit it hasn't recorded (see `docs/upgrade-recovery.md`).

### 6. Restart and verify

Restart the service (the operator runs this):

```bash
systemctl --user restart nanoclaw-v2-7f7e8f8c
```

Send a voice note to any agent. `logs/nanoclaw.log` should show
`Transcribed inbound audio attachments=1 transcribed=1`, and the agent should
reply to what you said.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Agent says it got audio it can't open | Check `logs/nanoclaw.error.log`. `Transcription request failed … status=500` is the server failing; test it directly with the curl above. No log line at all means `WHISPER_URL` is unset or the host wasn't restarted. |
| `Transcription unavailable … ECONNREFUSED` / timeout | Server down or asleep, or bound to an interface the host can't reach. |
| Only the first note after a while fails | Cold-start warm-up exceeded `WHISPER_TIMEOUT_MS`. Raise it to 20000. |
| Tests fail on "unset" cases | `.env` leaking into tests; `transcribe.test.ts` mocks `env.js` to prevent it. |

Removal: see [REMOVE.md](REMOVE.md).
