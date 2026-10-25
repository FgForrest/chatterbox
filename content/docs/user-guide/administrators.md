---
title: For administrators
description: What to switch on for each feature on a self-hosted instance.
---

Most of Chatterbox works as soon as it runs. A few features need the instance set up for them first. They are switched on with variables in `.env` (see `.env.example`) and, for some of them, extra services in `docker-compose.yml`. Restart the stack after changing either.

| Feature | What to set | More |
| --- | --- | --- |
| [The Organization](organization.md) | `ORG_ACCOUNT_EMAIL`, `ORG_ACCOUNT_PASSWORD` (12+ characters), optionally `ORG_ACCOUNT_NAME` | [Organization](../self-hosting/organization.mdx) |
| Single sign-on | `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, optionally `OIDC_PROVIDER_NAME`, `OIDC_SCOPES`, `OIDC_SESSION_MAX_AGE` | [Single sign-on](../self-hosting/sso.mdx) |
| [Access from the identity provider](#access-from-the-identity-provider) | `AUTHZ_MODE=idp`, `IDENTITY_PROVIDER=keycloak`, the three `KEYCLOAK_GROUP_*_ID`, `KEYCLOAK_VERIFIER_CLIENT_*` | [Single sign-on](../self-hosting/sso.mdx#authorization-from-the-identity-provider) |
| Closed registration | `DISABLE_REGISTRATION=true` | |
| [Folder exports to disk](exports-backups-retention.md#to-a-disk) | `FILESYSTEM_EXPORT_HOST_PATH` (Docker) or `FILESYSTEM_EXPORT_ROOT` | |
| [Google Drive exports](exports-backups-retention.md#to-google-drive) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_PICKER_API_KEY`, `GOOGLE_CLOUD_PROJECT_NUMBER`, optionally `GOOGLE_WORKSPACE_DOMAINS` | [Google Drive](../self-hosting/google-drive.mdx) |
| [Calendar and Meet](learn.md#calendar-meet-and-speaker-guesses) speaker suggestions | the same Google variables, plus the Calendar and Meet APIs and scopes in Google Cloud | [Calendar and Meet](../self-hosting/google-drive.mdx#calendar-and-meet) |
| [Mail](mail.md) | single sign-on, `MAIL_DOMAIN`, `MAIL_ADDRESS_HASH_SECRET`, `MAIL_INGEST_SECRET`, the `mail` profile with `MAIL_HOSTNAME` and `MAIL_TLS_DIR`, and DNS | [below](#inbound-mail) |
| [Meeting Recorder](../guides/meeting-recorder.mdx) defaults | nothing; optionally `RECORDER_AUTO_RECORD_PLATFORMS`, `RECORDER_AUTO_STOP_QUIET_SECONDS`, `RECORDER_NOTICE_TEXT`, `RECORDER_LOCK_DEFAULTS` | [below](#meeting-recorder-for-chrome) |
| Where backups are written | `BACKUP_STORAGE_PATH` | [Backup and restore](../guides/backup-and-restore.mdx) |
| Larger video uploads | `VIDEO_UPLOAD_MAX_BYTES` (default 4 GiB) | |
| Claude Code and Codex providers | the `agent-bridge` profile and `BRIDGE_TOKEN` | [below](#claude-code-and-codex-subscriptions) |
| MCP server for AI clients and services | `MCP_AUDIENCE` with single sign-on, optionally `MCP_ALLOWED_CLIENTS` | [External MCP server](../self-hosting/mcp.mdx) |
| [Chatterbox in Claude](claude.md) and Claude Code | Keycloak clients, `MCP_PUBLIC_INGRESS_HEADER`, `MCP_PUBLIC_CLIENTS`, `MCP_CONNECTOR_KEYS`, a public entrance for `/api/mcp` | [below](#claude-and-claude-code) |
| [Learn](learn.md) search by meaning | the `learn` profile and `EMBEDDING_BASE_URL` | [below](#learn) |
| Limit on automatic summaries, topics and Learn | `AUTO_SUMMARY_RATE_LIMIT_PER_HOUR` | |

## The Organization

Setting `ORG_ACCOUNT_EMAIL` and `ORG_ACCOUNT_PASSWORD` creates one organization account on start and gives every user the Organization folder tree. The email must not belong to an existing user. Share its password with whoever curates the Organization's people and exports. With single sign-on the password is optional.

Removing the two variables makes the Organization read-only: what was shared stays visible and nothing is deleted.

## Single sign-on

With the three `OIDC_` variables set, the sign-in page offers one **Sign in with …** button and password sign-in, registration and password reset are switched off. Register `<APP_URL>/api/auth/oauth2/callback/oidc` as the redirect URI at your identity provider. Existing accounts are linked on first sign-in when the provider confirms the email address.

With `DISABLE_REGISTRATION=true` as well, only people who already have an account can sign in. To let someone new in, unset it, restart, let them sign in once, and set it again.

## Access from the identity provider

With `AUTHZ_MODE=idp` your identity provider decides three things about
every person:

- **Access to Chatterbox** (`use`): without it nobody signs in, and their
  API keys, meeting recorder and AI clients stop working.
- **Curates the Organization** (`org.curate`): changes shared recordings
  on the Organization view (names of speakers, Learn, corrections,
  titles, summaries, topics, transcripts) under their own name.
- **Manages access** (`access.manage`): sees **Settings → Access** and
  switches the three rights for others there.

The rights are independent: an administrator is not a curator unless
given both, and neither works without access. Chatterbox keeps no list
of its own: what you switch in **Settings → Access** is written into the
identity provider's groups, with the administrator's own sign-in, and
read back from there. Nobody can take their own access or
administration away.

Taking access away signs the person out at once, here and at the
provider, and blocks their API keys and meeting recorder until access is
given back; recordings waiting in their browser are kept. If the
provider cannot sign them out, **Settings → Access** names the person at
the top until an administrator ends their sessions with **End
sessions**. A person disabled or deleted at the provider loses access within
`AUTHZ_VERIFICATION_MAX_AGE` (30 minutes by default) after Chatterbox
learns of it; how quickly your provider learns of it is up to your IT.

[Single sign-on](../self-hosting/sso.mdx#authorization-from-the-identity-provider)
explains the setup, including the command that prepares the Keycloak
realm and the first administrator.

## Inbound mail

With inbound mail on, everyone who signs in through single sign-on gets an address at your mail domain, every folder one that files into it, and every Organization folder one that colleagues can send to. A small SMTP server, the `mail-receiver` service (compose profile `mail`), accepts mail for that domain from Google's sending servers only and hands each message to Chatterbox, which checks the sender's signature before filing it.

It needs the variables in the table, port 25 reachable from the internet, an `MX` record and a certificate for `MAIL_HOSTNAME`. [Inbound mail](../self-hosting/mail.mdx) has every step, the DNS records and the checks to run after the first deployment. Send people to [Mail](mail.md).

## Meeting Recorder for Chrome

The Meeting Recorder extension needs no setup on the server: people install it from the Chrome Web Store through **Settings → Meeting Recorder** and connect it in three steps. See [Meeting Recorder](../guides/meeting-recorder.mdx).

Optionally, the server can choose defaults for everyone: which meeting platforms record with one click (`RECORDER_AUTO_RECORD_PLATFORMS`), after how many seconds of silence a recording stops (`RECORDER_AUTO_STOP_QUIET_SECONDS`), the recording policy shown before one-click recording is turned on (`RECORDER_NOTICE_TEXT`), and whether people may switch those platforms off (`RECORDER_LOCK_DEFAULTS`). Pass them to the app service under `environment:` in `docker-compose.yml`; see [Environment variables](../self-hosting/environment-variables.mdx#meeting-recorder).

## Claude Code and Codex subscriptions

The agent bridge lets summaries, topics, titles and Learn run on a Claude or ChatGPT subscription instead of an API key:

```bash
echo "BRIDGE_TOKEN=$(openssl rand -hex 32)" >> .env
docker compose --profile agent-bridge up -d --build agent-bridge
```

Sign the bridge in to Claude or Codex once (see `agent-bridge/README.md` in the repository), then in Chatterbox add a **Claude Code** or **Codex** provider with the bridge token as its API key. The bridge has no prebuilt image and publishes no port. It runs one request at a time by default; raise `BRIDGE_MAX_CONCURRENCY` to the number of passes if you use multi-pass summaries. Keep an API-key provider as a fallback.

## Claude and Claude Code

With the [external MCP server](../self-hosting/mcp.mdx) on, people can ask Claude (claude.ai, the desktop and mobile apps, Cowork) and Claude Code about their recordings, signed in through your Keycloak realm and limited by their roles there. Claude reaches Chatterbox from Anthropic's cloud, so this needs:

1. In Keycloak, a confidential client `claude` for the organization's connector, a public client `claude-code`, and one confidential client for each person who connects from a personal Claude plan.
2. A public DNS name and a reverse proxy that lets Anthropic's addresses (`160.79.104.0/21`) reach `/api/mcp` and its metadata, and nothing else, and marks those requests with a header.
3. In `.env`: `MCP_ALLOWED_CLIENTS`, `MCP_PUBLIC_INGRESS_HEADER`, `MCP_PUBLIC_CLIENTS` and, for the connector's `X-API-Key`, `MCP_CONNECTOR_KEYS`.
4. In Claude, an Owner adds the connector once with the `claude` client's ID and secret; members then connect it.

[Claude and Claude Code](../self-hosting/claude.mdx) has every step, the checks and what to do when a connection is refused. Send people to [Chatterbox in Claude](claude.md).

## Learn

Learn needs no setup beyond a provider that writes summaries. Two optional additions make it better:

- **Search by meaning.** `docker compose --profile learn up -d` starts the `embeddings` service (about 1.3 GB of memory; the first start downloads 1.2 GB). Set `EMBEDDING_BASE_URL=http://embeddings:11434/v1`.
- **Looking things up itself.** With a Claude Code or Codex provider behind the bridge, set `LEARN_MCP_URL=http://app:3000/api/mcp/learn` and `LEARN_BRIDGE_URL=http://agent-bridge:8787/v1` (exactly the provider's base URL), and raise `BRIDGE_TIMEOUT_MS` to `900000`. The model then queries the Almanac as it reads, instead of getting it all in its prompt.

## Meeting recorder (meetrec)

`meetrec` is a small Linux command-line recorder for meetings held in the browser. It records your microphone and the other participants into one Ogg/Opus file, with level meters while it runs, and stops when you press `Ctrl`+`C`. Upload the file to Chatterbox afterwards. It needs PipeWire, `pactl`, FFmpeg with Opus, and Go to build:

```bash
go build -o meetrec ./cmd/meetrec && ./meetrec
```

See `cmd/meetrec/README.md` in the repository. Recording other people requires their consent.

## AI providers in general

Transcription and summary providers are added by each user in Settings. Nothing here is needed for them. Self-hosted instances can point at local servers such as Ollama or LM Studio over the Docker network, so recordings never leave your machines.
