# Local speech-to-text for voice notes

Voice messages arrive from channels as audio attachments. Without transcription
the agent is handed a file path it cannot open — the model never learns what was
said. This wires a local Whisper server into the inbound path so the words reach
the agent as text, with no audio leaving the local network.

## Shape

```
Telegram voice note
      │
      ▼
router.ts  deliverToAgent()
      │  attachTranscripts()  ──HTTP──▶  Speaches / faster-whisper  (separate box)
      │       stamps att.transcript
      ▼
writeSessionMessage() → extractAttachmentFiles() → inbound.db
      │  (writes the .ogg to inbox/, strips `data`, keeps `transcript`)
      ▼
container formatter.ts → the agent sees the transcript inline
```

The agent's message block goes from this:

```
[voice: voice.ogg — saved to /workspace/inbox/<msgId>/voice.ogg]
```

to this:

```
[voice: voice.ogg — saved to /workspace/inbox/<msgId>/voice.ogg]
  transcript: ¿Puedes entender los audios?
```

## Why host-side

Transcription runs on the host, in the router, before the message is persisted —
not as a container-side MCP tool. Three reasons, in order of how much they bite:

1. **Small models don't call tools reliably.** A 4B-class local model will not
   dependably decide to invoke a `transcribe` tool. Host-side means the text is
   simply present and no tool call is involved.
2. **Container egress is constrained.** Containers reach the network through the
   OneCLI gateway proxy plus a per-group `blocked_hosts` list. A container-side
   call needs a `NO_PROXY` entry per agent group; miss one and it fails silently
   for that group only. Host-side works uniformly.
3. **The bytes are already in hand.** Attachments arrive as inline base64 on the
   inbound event, so nothing is re-read from disk.

It is awaited rather than fired-and-forgotten so the transcript lands in the same
row the container reads. A late patch could miss the container's first poll.

## Fail-open

Every failure path returns the message content untouched and routing continues:
`WHISPER_URL` unset, backend unreachable, HTTP error, timeout, oversized audio,
non-JSON content. The agent then sees exactly what it saw before this existed.

This matters because the transcription box may be a laptop. When it sleeps, the
cost is one `WHISPER_TIMEOUT_MS` per voice note and a warning in
`logs/nanoclaw.error.log` — never a stalled router or a dropped message.

## Host configuration

In `.env`:

| Key | Default | Meaning |
|-----|---------|---------|
| `WHISPER_URL` | *(unset)* | Base URL of the server. **Unset disables the feature.** |
| `WHISPER_MODEL` | `deepdml/faster-whisper-large-v3-turbo-ct2` | Model id, passed per request |
| `WHISPER_TIMEOUT_MS` | `8000` | Per-request timeout |
| `WHISPER_MAX_BYTES` | `26214400` | Refuse audio larger than this rather than uploading it |

## Server: Speaches via Docker Compose

Any OpenAI-compatible `/v1/audio/transcriptions` endpoint works.
[Speaches](https://speaches.ai/) is a good fit — it decodes Telegram's opus
natively, so no format conversion is needed.

`/opt/speaches/docker-compose.yml` on the GPU box:

```yaml
name: speaches

services:
  speaches:
    image: ghcr.io/speaches-ai/speaches:latest-cuda
    container_name: speaches
    restart: unless-stopped
    ports:
      - "<tailscale-ip>:8100:8000"    # bind to the private interface, not 0.0.0.0
    volumes:
      - ./cache:/home/ubuntu/.cache/huggingface/hub
    environment:
      WHISPER__INFERENCE_DEVICE: cuda
      WHISPER__COMPUTE_TYPE: float16
      STT_MODEL_TTL: "-1"
      LOG_LEVEL: info
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:8000/health || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 300s
```

`./cache` must be owned by uid 1000 or the model download fails at startup.
The healthcheck targets port 8000 because only the *published* port is moved to
8100; the server still listens on 8000 inside the container.

GPU passthrough needs `nvidia-container-toolkit` on the host, then
`nvidia-ctk runtime configure --runtime=docker` and a Docker restart. Verify with
`docker run --rm --gpus all nvidia/cuda:12.6.3-base-ubuntu24.04 nvidia-smi`
before starting the stack — without it, compose fails with
`could not select device driver "nvidia"`.

### Model choice

Two constraints drive this:

- **Multilingual.** The `distil-*` models are English-only. For any non-English
  speech use `large-v3` or a `large-v3-turbo` build.
- **VRAM shared with the LLM.** If the same GPU also serves an Ollama model,
  `STT_MODEL_TTL: -1` pins Whisper in VRAM permanently. On an 8GB card already
  holding a ~5GB LLM, `large-v3` at ~3.1GB will not fit; a turbo build at ~1.6GB
  will. Drop `WHISPER__COMPUTE_TYPE` to `int8_float16` to roughly halve it again.

Note there is no `Systran/faster-whisper-large-v3-turbo` — Systran never
published a turbo conversion. `deepdml/faster-whisper-large-v3-turbo-ct2` is the
community standard.

### Models are not auto-downloaded

A transcription request for a model that isn't installed returns
`Model '<id>' is not installed locally`. Install it once — the bind-mounted cache
persists it across restarts:

```bash
curl -X POST "http://<host>:8100/v1/models/deepdml/faster-whisper-large-v3-turbo-ct2"
curl -s "http://<host>:8100/v1/registry?task=automatic-speech-recognition"   # browse available ids
```

## Verifying

From the NanoClaw host — this is the path production traffic takes:

```bash
curl -sS http://<host>:8100/health
curl -sS http://<host>:8100/v1/audio/transcriptions \
  -F file=@some-voice-note.ogg \
  -F model=deepdml/faster-whisper-large-v3-turbo-ct2 | jq .text
```

Use a real voice note from `data/v2-sessions/*/inbox/` rather than a synthetic
wav — it exercises the opus decode path that actually matters.

Expect roughly 2s cold (model load) and well under 1s warm for a short note.
When it is working, `logs/nanoclaw.log` carries `Transcribed inbound audio` per
message; when it is not, `logs/nanoclaw.error.log` carries
`Transcription unavailable, continuing without it`.

## Key files

| File | Role |
|------|------|
| `src/transcribe.ts` | Client, audio detection, fail-open policy |
| `src/router.ts` | `deliverToAgent` calls `attachTranscripts` before persisting |
| `container/agent-runner/src/formatter.ts` | Renders `transcript` into the message block |
| `src/transcribe.test.ts` | Fail-open contract |
| `container/agent-runner/src/formatter.test.ts` | Rendering + XML escaping of transcripts |
