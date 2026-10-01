# Whisper server setups

Two setups that work with `/add-local-transcription`. Both expose an
OpenAI-compatible `POST /v1/audio/transcriptions` on port 8100, bound to the
Tailscale interface only.

## A. Mac with Apple Silicon: whisper.cpp (this install, Mac mini)

Native, uses the GPU through Metal. Speaches would run in Docker on macOS, and
Docker there can't use the Apple GPU.

| What | Value |
|---|---|
| Machine | Mac mini `maxlocalcloudmacos`, Tailscale `100.98.48.59` |
| Runs as | `llm-service` (same user as Ollama; its models are in `/Users/llm-service/.ollama/models`) |
| Model | `/Users/llm-service/whisper-models/ggml-large-v3-turbo-q5_0.bin` (547 MB) |
| RAM | ~750 MB, always loaded (peak ~790 MB) |
| Speed | ~0.6 s per short voice note |
| Startup file | `/Library/LaunchDaemons/com.llm-service.whisper-server.plist` |
| Log | `/Users/llm-service/whisper-server.log` |

Why `q5_0`: same quality as the full 1.5 GB model for short voice notes at a
third of the memory, and gemma4 already uses ~70% of the Mac's RAM.

### Install

1. Software (as your normal user). `ffmpeg` is required: Telegram voice notes
   are Ogg/Opus, and `--convert` uses it.
   ```
   brew install whisper-cpp ffmpeg
   ```

2. Model, as `llm-service`:
   ```
   sudo -u llm-service mkdir -p /Users/llm-service/whisper-models
   ```
   ```
   sudo -u llm-service curl -L -o /Users/llm-service/whisper-models/ggml-large-v3-turbo-q5_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
   ```

3. Startup file (paste the whole block):
   ```
   sudo tee /Library/LaunchDaemons/com.llm-service.whisper-server.plist >/dev/null <<'EOF'
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key><string>com.llm-service.whisper-server</string>
     <key>UserName</key><string>llm-service</string>
     <key>WorkingDirectory</key><string>/Users/llm-service</string>
     <key>EnvironmentVariables</key>
     <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string></dict>
     <key>ProgramArguments</key>
     <array>
       <string>/opt/homebrew/bin/whisper-server</string>
       <string>-m</string><string>/Users/llm-service/whisper-models/ggml-large-v3-turbo-q5_0.bin</string>
       <string>--host</string><string>100.98.48.59</string>
       <string>--port</string><string>8100</string>
       <string>--inference-path</string><string>/v1/audio/transcriptions</string>
       <string>--convert</string>
     </array>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
     <key>StandardOutPath</key><string>/Users/llm-service/whisper-server.log</string>
     <key>StandardErrorPath</key><string>/Users/llm-service/whisper-server.log</string>
   </dict>
   </plist>
   EOF
   ```

4. Check and start:
   ```
   sudo plutil -lint /Library/LaunchDaemons/com.llm-service.whisper-server.plist
   ```
   ```
   sudo launchctl bootstrap system /Library/LaunchDaemons/com.llm-service.whisper-server.plist
   ```

### Manage

| Task | Command |
|---|---|
| Status | `sudo launchctl print system/com.llm-service.whisper-server \| grep -E "state\|pid"` |
| Restart | `sudo launchctl kickstart -k system/com.llm-service.whisper-server` |
| Stop | `sudo launchctl bootout system/com.llm-service.whisper-server` |
| Start (after stop or plist edit) | `sudo launchctl bootstrap system /Library/LaunchDaemons/com.llm-service.whisper-server.plist` |
| Log | `sudo tail -n 40 /Users/llm-service/whisper-server.log` |
| Memory | `sudo footprint $(pgrep -x whisper-server) \| grep -i footprint` |

### Gotchas

- **`current_path() failure: Permission denied`.** It was started from another
  user's folder. It must run from `/Users/llm-service`, which `WorkingDirectory`
  does. By hand: `sudo -u llm-service sh -c 'cd /Users/llm-service && exec /opt/homebrew/bin/whisper-server ...'`.
- **`PATH` in the plist is required**, or `--convert` can't find `ffmpeg`.
- **Bound to the Tailscale IP.** If the Mac boots before Tailscale is up, the
  first start fails to bind; `KeepAlive` retries until it's ready.
- **First request after a restart** can take ~15 s (GPU warm-up), hence
  `WHISPER_TIMEOUT_MS=20000` on the host.
- **The `model` request field is ignored**; the server always uses the model it
  loaded.

### Options considered

- **On-demand instead of always-on.** whisper-server can't sleep when idle. A
  small gatekeeper could start it on the first voice note and stop it after
  ~10 idle minutes, at the cost of a few seconds' wait on that first note. Not
  done because 750 MB was acceptable; revisit if gemma4 starts swapping.
- **Other models:** `ggml-large-v3-turbo-q8_0.bin` (~830 MB) is slightly more
  accurate; `ggml-small.bin` (~470 MB) is less accurate. Swap the filename in
  the plist and restart.

### Remove

```
sudo launchctl bootout system/com.llm-service.whisper-server
```
```
sudo rm /Library/LaunchDaemons/com.llm-service.whisper-server.plist
```
```
sudo rm -rf /Users/llm-service/whisper-models /Users/llm-service/whisper-server.log
```

## B. Linux with an NVIDIA GPU: Speaches in Docker Compose

Used on the Blade 15 until 2026-10-01, when it started returning HTTP 500 on
every request (health OK, model listed, GPU free; never diagnosed). Speaches
decodes Telegram's opus natively, so no conversion is needed.

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

- `./cache` must be owned by uid 1000 or the model download fails at startup.
- The healthcheck targets port 8000; only the *published* port is 8100.
- GPU passthrough needs `nvidia-container-toolkit`, then
  `nvidia-ctk runtime configure --runtime=docker` and a Docker restart. Verify
  with `docker run --rm --gpus all nvidia/cuda:12.6.3-base-ubuntu24.04 nvidia-smi`;
  without it, compose fails with `could not select device driver "nvidia"`.
- Models are not auto-downloaded. Install once (the cache persists it):
  `curl -X POST "http://<host>:8100/v1/models/deepdml/faster-whisper-large-v3-turbo-ct2"`.
  A request for a missing model returns `Model '<id>' is not installed locally`.
- Model choice: `distil-*` models are English-only; use `large-v3` or a
  `large-v3-turbo` build for other languages. There is no
  `Systran/faster-whisper-large-v3-turbo`; `deepdml/faster-whisper-large-v3-turbo-ct2`
  is the community conversion. On an 8 GB card shared with a ~5 GB LLM, only a
  turbo build fits (~1.6 GB); `WHISPER__COMPUTE_TYPE: int8_float16` roughly
  halves it again.
