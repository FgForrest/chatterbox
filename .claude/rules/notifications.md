---
paths:
  - "src/lib/notifications/**"
---

# Notification backends

Notifications have no shared interface: `src/lib/notifications/{bark,browser,email}.ts` are separate
files, each invoked directly by callers (e-mail rendering lives beside them in `email-templates/`,
`render-email.ts` and `email-template-*.ts`).

## Adding a notification backend

1. Write `src/lib/notifications/<name>.ts` exporting a `send<Name>Notification()` function.
2. Wire it into callers (check how `bark.ts` and `email.ts` are called for the pattern).
3. Add env vars following `.claude/rules/deploy-surface.md` (`src/lib/env.ts`, `.env.example`,
   `docker-compose.yml`, docs).
4. Add a settings UI toggle if the backend is user-configurable.
5. Include a timeout (see `bark.ts` for the 3-second pattern): notifications must never block the
   sync loop.

Consider introducing a shared `NotificationProvider` interface if you're adding the third or fourth
backend. For now, the flat file-per-backend structure is fine.

SMTP credentials are encrypted at rest (`AGENTS.md`, Encryption at rest).
