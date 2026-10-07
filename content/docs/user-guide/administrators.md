---
title: For administrators
description: What to switch on for each feature on a self-hosted instance.
---

Most of Riffado works as soon as it runs. A few features need the instance set up for them first. They are switched on with variables in `.env` (see `.env.example`) and, for two of them, extra services in `docker-compose.yml`. Restart the stack after changing either.

| Feature | What to set | More |
| --- | --- | --- |
| [The Organization](organization.md) | `ORG_ACCOUNT_EMAIL`, `ORG_ACCOUNT_PASSWORD` (12+ characters), optionally `ORG_ACCOUNT_NAME` | [Organization](../self-hosting/organization.mdx) |
| Single sign-on | `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, optionally `OIDC_PROVIDER_NAME`, `OIDC_SCOPES`, `OIDC_SESSION_MAX_AGE` | [Single sign-on](../self-hosting/sso.mdx) |
| Closed registration | `DISABLE_REGISTRATION=true` | |
| [Folder exports to disk](exports-backups-retention.md#to-a-disk) | `FILESYSTEM_EXPORT_HOST_PATH` (Docker) or `FILESYSTEM_EXPORT_ROOT` | |
| [Google Drive exports](exports-backups-retention.md#to-google-drive) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_PICKER_API_KEY`, `GOOGLE_CLOUD_PROJECT_NUMBER`, optionally `GOOGLE_WORKSPACE_DOMAINS` | [Google Drive](../self-hosting/google-drive.mdx) |
| Where backups are written | `BACKUP_STORAGE_PATH` | [Backup and restore](../guides/backup-and-restore.mdx) |
| Larger video uploads | `VIDEO_UPLOAD_MAX_BYTES` (default 4 GiB) | |
| Claude Code and Codex providers | the `agent-bridge` profile and `BRIDGE_TOKEN` | [below](#claude-code-and-codex-subscriptions) |
| [Learn](learn.md) search by meaning | the `learn` profile and `EMBEDDING_BASE_URL` | [below](#learn) |
| Limit on automatic summaries, topics and Learn | `AUTO_SUMMARY_RATE_LIMIT_PER_HOUR` | |

## The Organization

Setting `ORG_ACCOUNT_EMAIL` and `ORG_ACCOUNT_PASSWORD` creates one organization account on start and gives every user the Organization folder tree. The email must not belong to an existing user. Share its password with whoever curates the Organization's people and exports. With single sign-on the password is optional.

Removing the two variables makes the Organization read-only: what was shared stays visible and nothing is deleted.

## Single sign-on

With the three `OIDC_` variables set, the sign-in page offers one **Sign in with …** button and password sign-in, registration and password reset are switched off. Register `<APP_URL>/api/auth/oauth2/callback/oidc` as the redirect URI at your identity provider. Existing accounts are linked on first sign-in when the provider confirms the email address.

With `DISABLE_REGISTRATION=true` as well, only people who already have an account can sign in. To let someone new in, unset it, restart, let them sign in once, and set it again.

## Claude Code and Codex subscriptions

The agent bridge lets summaries, topics, titles and Learn run on a Claude or ChatGPT subscription instead of an API key:

```bash
echo "BRIDGE_TOKEN=$(openssl rand -hex 32)" >> .env
docker compose --profile agent-bridge up -d --build agent-bridge
```

Sign the bridge in to Claude or Codex once (see `agent-bridge/README.md` in the repository), then in Riffado add a **Claude Code** or **Codex** provider with the bridge token as its API key. The bridge has no prebuilt image and publishes no port. It runs one request at a time by default; raise `BRIDGE_MAX_CONCURRENCY` to the number of passes if you use multi-pass summaries. Keep an API-key provider as a fallback.

## Learn

Learn needs no setup beyond a provider that writes summaries. Two optional additions make it better:

- **Search by meaning.** `docker compose --profile learn up -d` starts the `embeddings` service (about 1.3 GB of memory; the first start downloads 1.2 GB). Set `EMBEDDING_BASE_URL=http://embeddings:11434/v1`.
- **Looking things up itself.** With a Claude Code or Codex provider behind the bridge, set `LEARN_MCP_URL=http://app:3000/api/mcp/learn` and `LEARN_BRIDGE_URL=http://agent-bridge:8787/v1` (exactly the provider's base URL), and raise `BRIDGE_TIMEOUT_MS` to `900000`. The model then queries the Almanac as it reads, instead of getting it all in its prompt.

## Meeting recorder (meetrec)

`meetrec` is a small Linux command-line recorder for meetings held in the browser. It records your microphone and the other participants into one Ogg/Opus file, with level meters while it runs, and stops when you press `Ctrl`+`C`. Upload the file to Riffado afterwards. It needs PipeWire, `pactl`, FFmpeg with Opus, and Go to build:

```bash
go build -o meetrec ./cmd/meetrec && ./meetrec
```

See `cmd/meetrec/README.md` in the repository. Recording other people requires their consent.

## AI providers in general

Transcription and summary providers are added by each user in Settings. Nothing here is needed for them. Self-hosted instances can point at local servers such as Ollama or LM Studio over the Docker network, so recordings never leave your machines.
