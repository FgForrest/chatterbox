---
title: The product names itself per deployment through one deployment-aware name, and self-host stops showing upstream names
date: 2026-10-18
updated: 2026-10-22 16:00
status: accepted
kind: feature
issues: []
prs: [50, 101, 103, 149, 172]
areas: [src/lib/brand.ts, src/lib/deployment-brand.ts, src/components/product-name-provider.tsx, messages, docker-compose.yml, .env.example, src/tests/i18n/self-host-branding.test.ts]
supersedes: []
superseded-by: []
relates: []
---

# The product names itself per deployment through one deployment-aware name, and self-host stops showing upstream names

A self-hosted instance no longer shows "Riffado" or "Mynah"; it names itself Chatterbox in English and
Klepna in Czech. A hosted deployment keeps the upstream name. Rather than patching each string, every
place that names the product asks one deployment-aware function: `deploymentProductName(locale)` on
the server, `useProductName()` on the client, and every brand mention in the message catalogs is a
`{name}` placeholder (PR #149). A guard test fails on upstream names in self-host copy. The release
compose file pulls this repository's image, pinned by `CHATTERBOX_VERSION`, with the old
`RIFFADO_VERSION` still accepted for one release.

## Why

The maintainer runs a self-hosted deployment for colleagues. The upstream product name and the name
of upstream's hosted transcription service appeared in labels, help, descriptions and e-mails, and
were "clearly confusing in relation to chatterbox and self-host environment".

The constraints:

- **Two production modes from one codebase.** Hosted (`IS_HOSTED=true`) is a real deployment of the
  upstream product, and AGENTS.md requires its managed provider to keep its upstream label. A fix for
  self-host must not rename hosted.
- **Client components knew only the locale, not the deployment mode.** `productName(locale)` returned
  Chatterbox or Klepna for any deployment, so every fix that wanted hosted to stay upstream had to
  thread `isHosted` by hand.
- **The image tag variable is deploy surface.** Renaming it needs a deprecation window.

### Previous state

Czech localization arrived with PR #50 and Czech documentation and help with PR #101. PR #103 renamed
the product Klepna (Czech) and Chatterbox (English) through `productName()`, with attribution and
links to the upstream repository. Much copy still said "Riffado"; shared copy mentioned "Mynah"
(for example a transcription default hint); install docs and `docker-compose.yml` pointed at the
upstream image and repository with `RIFFADO_VERSION`; e-mails without a configured sender fell back
to the upstream project's no-reply address.

## Options considered

### Scope: everything a self-hosted instance can show (chosen)

App UI, help drawer and `/docs`, self-host e-mails, and the ungated upstream announcement pages.
`IS_HOSTED`-only landing, legal, pricing, changelog and billing copy keep the upstream name. License,
copyright, upstream attribution and author credits stay everywhere.

### Scope: rename everything, hosted-only copy included (declined)

- **Rejected because:** the hosted-only legal and pricing pages describe the upstream hosted service;
  renaming them would put this product's name on terms and privacy pages for a service it does not
  run.

### The managed provider's name: hide it on self-host (chosen) versus remove it everywhere (declined)

- **Rejected because:** removing it would rename the managed provider on hosted too and override the
  AGENTS.md rule that hosted surfaces it under its own name. Self-host never has the provider, so
  showing it only where it is configured is enough.

### Identifiers: also change image and repository names in docs and compose (chosen)

Offered alongside "prose only" (rename the product in sentences, keep the upstream image and
repository references) and "prose only, keep the fallback sender".

- **Rejected because:** prose-only docs would keep telling self-hosters to pull the upstream image and
  read the upstream repository, which is not what this fork ships (inferred from the maintainer's
  choice).

### Which identifiers: this repository's own (chosen) versus neutral placeholders (declined)

Neutral placeholders (`<registry>/chatterbox:<tag>`, "this project's repository") were recommended
because the repository owner's name is the operator's name, which the project keeps out of sources.

- **Rejected because:** the maintainer chose the real identifiers, as a narrow exception for the
  repository and registry names only; it must not spread to prose, examples or fixtures. Install
  commands stay copy-pasteable (inferred).

### Compose and env: switch the image and add `CHATTERBOX_VERSION` (chosen) versus docs only (declined)

- **Rejected because:** docs only would leave the release compose file pulling the upstream image.
  The rename follows the deploy-surface rule: the old variable keeps working for one release.

### Hosted naming: fix it everywhere with one deployment-aware name (chosen)

A root-layout context gives every client and server place one name for this deployment; every brand
mention in the catalogs becomes `{name}`; a guard test fails on literal product names in the catalogs.

### Hosted naming: declare hosted out of scope for this fork (declined)

The fork never runs hosted, so the promise could be dropped: name the product Chatterbox or Klepna in
every mode and stop re-branding hosted-only code.

- **Rejected because:** the review bot kept finding places where hosted would now say Chatterbox (eight
  in one round: summary source, storage settings, erase dialogs, the Drive export folder label, the
  docs site title, Plaud connect hints). Point fixes would keep recurring; one systemic name ends the
  bug class and keeps hosted correct, as the codebase's two-mode contract requires.

## Decision

**One deployment-aware product name, self-host scope, hosted unchanged.** New user-facing copy uses
`deploymentProductName()` or `useProductName()` and a `{name}` placeholder, never a literal brand;
copy about the managed provider appears only on hosted paths. Revisit only if the codebase stops
shipping a hosted mode.

## Key technical details

- `src/lib/brand.ts`: `productName(locale)` (Chatterbox for English, Klepna for `cs-CZ`) and
  `UPSTREAM_PRODUCT_NAME`, the only upstream-name constant (hosted, and the historical rebrand
  announcement).
- `src/lib/deployment-brand.ts`: `deploymentProductName(locale)` returns the upstream name when
  `IS_HOSTED`, else `productName(locale)`. Client: `useProductName()` and `useHostedDeployment()` from
  `src/components/product-name-provider.tsx`.
- Czech copy declines the name as Czech grammar needs (Klepna, Klepny, Klepně, Klepnu, Klepnou), and
  never uses the English name; the recorder extension does the same through its `appName` message.
- Stay unchanged on purpose: code constants such as `RIFFADO_INCLUDED_PROVIDER_ID`, container, volume
  and service names (`riffado-*`), every other env var.
- `docker-compose.yml`: the image tag is `${CHATTERBOX_VERSION:-${RIFFADO_VERSION:-latest}}`. Compose
  reads the variable without passing it to the app, so no runtime deprecation warning is possible;
  the upgrade note in PR #149 and the comment in `.env.example` are the warning.
- E-mail sender fallback without `SMTP_FROM` or `SMTP_USER`: a `noreply` address on the `APP_URL`
  host, then on `localhost`.
- The upstream announcement and newsletter pages and the newsletter subscribe and confirm endpoints
  answer 404 unless `IS_HOSTED`; unsubscribe links work everywhere. "Report a bug" opens a blank issue
  in this repository, and the issue templates were removed.

## Verification

- `src/tests/i18n/self-host-branding.test.ts`: fails on the upstream product or provider name in the
  message catalogs and docs outside an allowlist of hosted-only copy and attribution.
- `src/tests/i18n/deployment-branding.test.tsx` and `hosted-only-pages.test.tsx`;
  `src/tests/report-bug.test.ts`.
- PR #149: whole unit suite 3,827 passed, whole database suite 5,046 passed sequentially;
  `docker compose config` checked with no version set, with `RIFFADO_VERSION`, and with
  `CHATTERBOX_VERSION` taking precedence. PR #172: 5,342 passed.

## Consequences & open follow-ups

- `RIFFADO_VERSION` was promised for one release only; the fallback in `docker-compose.yml` and
  `.env.example` is still there and should be removed with a release note.
- Renaming the `riffado-*` container, volume and service names would be a breaking compose change;
  left for later.
- An install that sends mail without `SMTP_FROM` or `SMTP_USER` now sends from its own host; a relay
  that accepts only specific senders needs `SMTP_FROM`.

## Timeline

- **2026-09-18**: English and Czech localization (PR #50).
- **2026-10-08**: Czech documentation and help (PR #101); the product renamed Klepna and Chatterbox
  with upstream attribution (PR #103).
- **2026-10-18**: the maintainer's scope, provider, identifier and compose rulings, then "fix it
  everywhere" for hosted naming; PR #149 merged.
- **2026-10-19**: leftover English terms in the Czech UI and docs replaced (PR #172).
- **2026-10-21**: ruling that every Czech string uses the declined Czech name.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
