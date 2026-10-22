---
title: The setup wizard on a self-hosted Organization is built for employees, skips what the Organization provides, and reads readiness from the pipeline's own resolver
date: 2026-10-19
updated: 2026-10-22 17:05
status: accepted
kind: feature
issues: []
prs: [136, 182]
areas: [src/components/onboarding-dialog.tsx, src/components/onboarding-steps.tsx, src/lib/onboarding/readiness.ts, src/lib/onboarding/capabilities.ts, src/app/api/onboarding/readiness, src/components/meeting-recorder-setup.tsx]
supersedes: []
superseded-by: []
relates: [2026-10-19-provider-defaults-and-no-fallback, 2026-10-21-meeting-recorder-extension]
---

# The setup wizard on a self-hosted Organization is built for employees, skips what the Organization provides, and reads readiness from the pipeline's own resolver

The setup wizard (Welcome, Plaud, AI provider, Google, Meeting Recorder, mail, Claude; PR #136) now
knows who is setting up (PR #182). On a self-hosted instance with an Organization, an employee whose
Organization already covers transcription and summaries gets no AI step at all; the finish summary
names the Organization's providers. A partly covered member sees the AI step only for the missing
role. The Claude step leads with the connector a Claude Team or Enterprise admin already added, so
the employee only clicks Connect. The Organization account sees only Organization providers,
defaults and profiles, never personal steps, and the recorder routes refuse it on the server. The
maintainer's guiding sentence: "We optimize for employee onboarding here."

## Why

The wizard counted only personal providers. On a self-hosted instance whose Organization had set up
providers and profiles for everyone, new employees were still asked to add providers, and inherited
providers showed as "Skipped". At the same time a new member could not transcribe at
all (`NO_TRANSCRIPTION_PROVIDER`) when the Organization had providers but no default pointers, which
showed that "what is this member covered by" must have one answer for the wizard and the pipeline.

The Claude step described only personal setup (a connector URL, `claude mcp add`), while in a company
the Claude admin adds the connector once for everyone.

### Previous state

PR #136 made the steps data, each skippable with a connected state, and added "Run setup again" to
the user menu. Readiness came from personal provider rows only; the same steps were shown to the
Organization account as to a person.

## Options considered

### AI step for a covered employee: skip it, name the Organization's providers in the summary (chosen)

- **Pros:** the employee never sees a step that asks for something already done.
- **Cons:** someone who wants their own provider finds it in Settings, not in the wizard.

### AI step as a short "Provided by your Organization" confirmation with "Use my own provider" (declined)

- **Rejected because:** the maintainer chose the skip; a step that only confirms adds a click to every
  employee's setup (inferred). Members can still add their own provider under Settings.

### Claude step: the enterprise connector as the main path (chosen)

The employee finds the connector the admin added in the Claude app and clicks Connect; adding a
custom connector or `claude mcp add` are the alternatives below it.

### Claude step: personal setup first (declined)

Copy the connector URL into Claude, or run `claude mcp add`, as the step described before.

- **Rejected because:** it fits a single user, not an employee whose Claude admin already added the
  connector for everyone; the maintainer asked to describe the case where the enterprise manager has
  set it up and to connect in the Claude app, not only through the command.

### The Organization account: hide personal steps (chosen) versus leave as is (declined)

- **Rejected because:** leaving it was offered as cheap since SSO blocks the Organization login, but
  the account can still sign in with a local password, and Plaud, Google, the recorder and Claude
  belong to a person, not to the Organization. PR #182 also made the recorder pairing, status, rebind,
  session and upload routes refuse the Organization account, as the Plaud and upload routes already
  did.

### Recorder: guide the current flow and also ship an extension update (chosen)

Alternatives offered: guide the current relay flow in the app only (extension release later), or hide
the recorder step from employees. The maintainer chose both the in-app guidance and an extension
update that continues from consent straight into site access and pairing.

- **Rejected because:** hiding the step leaves employees to find the recorder in Settings; an app-only
  change left a toolbar visit the extension could remove. The extension side is its own record.

## Decision

**Optimize the self-hosted Organization case for the employee.** Skip what the Organization covers,
lead with what the admin already set up, and keep personal steps away from the Organization account.
Single-user and hosted instances keep the optional flow. A new wizard step must ask the same question:
does the Organization already provide this for the member?

## Key technical details

- One read-only loader, `src/lib/onboarding/readiness.ts`, feeds both the dashboard seed and
  `GET /api/onboarding/readiness`. **Invariant:** it decides coverage with the pipeline's own provider
  resolution (`resolveStepProviderSelection` and the effective profile pins), so the wizard can never
  call a member covered whom the pipeline would refuse, or the reverse. It never provisions anything,
  decrypts keys, reserves AI calls or persists authorization verdicts.
- Audiences: single user or hosted; Organization member (covered, or partly covered with the missing
  role named); Organization account. The Organization account's coverage is computed as a member with
  no personal choices would get it: Organization defaults, then the Organization fallback.
- Settings buttons inside the wizard open Settings in-app and return to the same step; an OAuth return
  no longer resets earlier steps; Plaud `needsReconnect` shows; loading no longer reads as "Skipped".
- Readiness is seeded only while onboarding is incomplete; afterwards the dialog fetches it when
  opened, so a finished user's dashboard pays nothing.
- Upgrade hazard noted in PR #182: recorder sessions started under the Organization account fail after
  deploy, because their chunk, complete and recover requests are now refused. The first refusal per
  account and surface in ten minutes is logged (the PR text says "sent to Sentry", but no error
  tracker is wired into the code).
- `src/components/connected-line.tsx` (PR #189) gives every step the same connected line.

## Verification

- `src/tests/onboarding/readiness.integration.test.ts` (PostgreSQL, 23 cases: Organization defaults
  and fallback, the Organization account matching a fresh member, personal and foreign selections,
  profile pins, disabled providers, Mynah entitlement, stale IdP checks and an IdP outage).
- `src/tests/onboarding/readiness-route.test.ts` (401 when signed out, `no-store`, session user only),
  `src/tests/regressions/recorder-org-account-refused.test.ts` (every recorder entry point refuses the
  Organization account; member sessions still work), `src/tests/dashboard/onboarding-dialog.test.tsx`
  (35 cases at merge: audiences, step visibility, OAuth hydration, recorder states).
- Not exercised at merge: live Google OAuth, the Claude connector and extension pairing in a real
  browser.

## Consequences & open follow-ups

- The new-member provider failure was fixed separately through the Organization fallback; this wizard
  depends on that resolver staying the single source of coverage.
- The Organization account cannot use the Meeting Recorder at all; recordings belong to people.

## Related work

- [2026-10-19-provider-defaults-and-no-fallback](2026-10-19-provider-defaults-and-no-fallback.md): the
  Organization defaults and fallback that decide what a member is covered by, which readiness reuses.
- [2026-10-21-meeting-recorder-extension](2026-10-21-meeting-recorder-extension/README.md): the
  extension update that the recorder step guides (consent, site access, pairing, microphone state).

## Timeline

- **2026-10-16**: wizard steps for Google, Meeting Recorder, mail and Claude, and "Run setup again"
  (PR #136).
- **2026-10-19**: the maintainer's rulings on the AI step, the Claude step, the Organization account
  and the recorder; PR #182 merged.
- **2026-10-20**: follow-up: consistent connected line for the recorder step (PR #189).
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
