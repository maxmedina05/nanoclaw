# Remove /add-local-transcription

1. Remove the barrel line from `src/modules/index.ts`:
   ```typescript
   import './transcription/index.js';
   ```

2. Delete the module:
   ```bash
   rm -rf src/modules/transcription
   ```

3. Remove the `WHISPER_*` keys from `.env`. (Leaving `WHISPER_URL` unset is enough
   to turn the feature off without removing code.)

4. Build, stamp, restart:
   ```bash
   pnpm run build
   pnpm exec tsx scripts/upgrade-state.ts set
   systemctl --user restart nanoclaw-v2-7f7e8f8c
   ```

5. Optionally remove the Whisper server itself; see the "Remove" section of
   [references/whisper-server.md](references/whisper-server.md).

Voice notes then reach agents as audio files again.
