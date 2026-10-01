# Remove /add-zoho-workdrive

1. Stop and remove the timer:
   ```bash
   systemctl --user disable --now zoho-token-refresher.timer
   rm ~/.config/systemd/user/zoho-token-refresher.service ~/.config/systemd/user/zoho-token-refresher.timer
   systemctl --user daemon-reload
   ```

2. Delete the OneCLI secret (find its id with `onecli secrets list`):
   ```bash
   onecli secrets delete --id <id>
   ```

3. Delete the scripts and the upload CLI's token cache:
   ```bash
   rm scripts/zoho-token-refresher.ts scripts/zoho-workdrive-upload.ts data/zoho-token-cache.json
   ```

4. Remove the "Zoho WorkDrive uploads" section from the agent's
   `groups/<folder>/instructions.prepend.md`.

The Zoho credentials in 1Password are untouched; revoke the Self Client's
refresh token in the Zoho API console if it's no longer needed anywhere.
