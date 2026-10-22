---
paths:
  - "src/lib/hosted/**"
  - "src/app/*hosted*/**"
  - "src/app/api/stripe/**"
  - "src/lib/entitlements.ts"
  - "src/db/queries/billing.ts"
  - "src/lib/transcription/included-provider.ts"
  - "src/app/api/v1/**"
  - "src/lib/v1/**"
  - "src/lib/webhooks/**"
  - "src/lib/rate-limit.ts"
  - "src/lib/auth-request.ts"
---

# Hosted mode (`IS_HOSTED=true`), the public API, Mynah

## What hosted is

- **Hosted** is the multi-tenant service upstream Riffado operates from this codebase with
  `IS_HOSTED=true`: multiple Next.js processes behind a load balancer, shared Postgres, real users
  paying real money. This is not aspirational. Treat it as production.
- `IS_HOSTED` is the deployment-mode switch. Today it gates the marketing landing page
  (`src/app/page.tsx` redirects to `/login` when unset) and is the default for hosted-strict
  safety knobs. It is **not** the signup switch: sign-up is gated by `DISABLE_REGISTRATION` (wired
  into `src/lib/auth.ts` via `disableSignUp`). Billing and plan-aware hosted UI are gated by
  dedicated knobs such as `BILLING_ENABLED`, Stripe configuration, and Mynah configuration; do not
  overload `IS_HOSTED` as a feature switch.
- Code that branches on mode reads `env.IS_HOSTED`; never sniff `process.env` directly. Default
  behavior is always the self-host path; `IS_HOSTED=true` opts in to the stricter,
  marketing-enabled mode. Hosted-only branches degrade cleanly to the self-host path, never crash or
  silently disable what self-hosters expect.

## Hosted invariants

When designing or reviewing any feature, assume hosted is real and check both modes. The
multi-process, multi-tenant and per-user-fairness rules apply to all background work and are in
`AGENTS.md`; these are the hosted-specific ones:

- **Egress is hostile territory.** Outbound HTTP from hosted infra (webhooks, AI proxying, etc.)
  defaults to public destinations only and DNS-pins to resolved IPs. Self-host needs the opposite
  default (a homelab `http://n8n:5678/...` over the docker bridge must work). Branch the default on
  `IS_HOSTED` (`WEBHOOKS_REQUIRE_PUBLIC_TARGETS` follows it), not on hardcoded policy.
- **Secrets at rest.** Hosted DB exfiltration is a multi-user incident. High-entropy secrets (API
  tokens) are hashed with HMAC keyed off `API_TOKEN_HASH_SECRET`, falling back to
  `BETTER_AUTH_SECRET` (see `src/lib/auth-request.ts`), not plain SHA-256. Never reuse
  `ENCRYPTION_KEY` for HMAC; that key is reserved for AES-GCM at-rest encryption via
  `src/lib/encryption.ts`.
- **Rate limiting on `/api/v1/*`.** Per token and per IP (`src/lib/rate-limit.ts`). Required before
  hosted exposes a new write endpoint or a new external surface.
- **No claims of compliance we don't own.** Hosted does not make anyone HIPAA or SOC2 compliant.
  Don't ship copy that says it does.

## The hosted contract

The external API at `/api/v1/*` (automation API, personal API keys, signed webhooks), webhook
payloads, the token format, and API behavior under load are a contract for hosted customers and
for self-hosters' automations. Change them additively; anything else is a breaking change with a
migration note. The meeting recorder extension also calls `/api/v1/recorder/*` and
`/api/v1/recording-sessions/*` (`.claude/rules/recorder-extension.md`).

## Mynah: hosted included transcription

**Mynah** is a real upstream Riffado product (`mynah.riffado.com`), not an internal codename: the
hosted transcription backend included with a paid plan. Surface it as **"Mynah"** in hosted
user-facing copy; only the underlying model name (`parakeet`) stays internal. Self-hosted
deployments never show it (`.claude/rules/i18n.md`, product naming).

- **First-class managed provider, not a hidden fallback.** Instance-configured via env
  (`MYNAH_BASE_URL`, `MYNAH_SERVICE_TOKEN`); `isMynahConfigured()` requires `IS_HOSTED`, so
  self-host never sees it. It is **never** a row in `api_credentials`: it is surfaced as a
  synthetic managed provider with id `RIFFADO_INCLUDED_PROVIDER_ID` (`"riffado-included"`) and
  label `RIFFADO_INCLUDED_PROVIDER_LABEL`, both in `src/lib/transcription/included-provider.ts`.
  `listUserProviders()` (`src/lib/ai/list-providers.ts`) prepends it for the Providers UI and SSR
  seed.
- Selection precedence and provider defaults are in `.claude/rules/ai-providers.md`: an explicit
  credential id that doesn't resolve **must fail loudly**, never silently fall to Mynah.
- **Entitlement-gated.** Only `hosted_pro` (including the transition window) has
  `monthlyMynahSeconds > 0`. Metered per user via `reserveMynah`/`commit`/`release`; budget
  exhaustion surfaces product copy, not the raw error. Self-host has no Mynah; lapsed accounts show
  it locked.
- **Complimentary, not a replacement.** Users can always add their own provider (Settings →
  Providers) and switch the transcription default between Mynah and their key; both coexist.
  Onboarding frames Mynah as included plus optional own provider, and must not treat "has Mynah"
  as "user brought their own provider."

## Private operations repository

Hosted production runbooks live in upstream's private `riffado/ops` repository, not in this public
repository (`AGENTS.md` § Public repository).
