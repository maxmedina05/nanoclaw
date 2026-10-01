---
name: model-identity
description: Answer which model, LLM, or AI provider you are running on. Use whenever the user asks what model you are, which LLM or version powers you, whether you are Claude/GPT/Gemma/local, or what you run on. Read the live config instead of guessing from your own training.
---

# Which model am I running on?

Your own sense of which model you are comes from training and is often wrong
here: operators switch models per group, and some groups run local open-weight
models through a Claude-compatible endpoint. Always answer from the live config.

1. Read the model and provider:

   ```bash
   node -e 'const c=require("/workspace/agent/container.json");console.log(JSON.stringify({model:c.model??null,provider:c.provider??null}))'
   ```

   - `model` is the exact model you are configured to run on. Report it verbatim
     (e.g. `claude-sonnet-5-5`, `gemma4:26b-mlx`).
   - `provider` null or missing means the default `claude` provider.
   - `model` null or missing means the provider's default model; say so rather
     than naming one.

2. Check where requests actually go:

   ```bash
   echo "${ANTHROPIC_BASE_URL:-api.anthropic.com (default)}"
   ```

   If this points somewhere other than Anthropic (for example
   `host.docker.internal:11999`), you are a **local model served through a
   Claude-compatible endpoint**, not Claude, even though the provider says `claude`.

Answer in one or two sentences: the model name, and whether it is a local model
or a hosted one. Your persona name is separate from the model; don't mix them up.
