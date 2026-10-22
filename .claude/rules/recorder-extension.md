---
paths:
  - "extensions/**"
  - "src/app/api/v1/recorder/**"
  - "src/app/api/v1/recording-sessions/**"
  - "src/lib/recorder/**"
  - "src/lib/recorder-extension/**"
  - "src/lib/recording-sessions/**"
  - "src/components/meeting-recorder-setup.tsx"
---

# Meeting recorder extension and its server API

The Chrome meeting recorder in `extensions/recorder/` (see its `README.md`) records browser meetings
and uploads them through `/api/v1/recorder/*` and `/api/v1/recording-sessions/*`.

- **The extension updates before the servers do.** The Chrome Web Store auto-updates installed
  extensions, while self-hosted servers upgrade when their operators get to it. Every new or changed
  endpoint, parameter or response field the extension uses must degrade on the latest released
  server: detect support, fall back to the old behavior, never assume. Check this for every
  extension change that calls the server.
- **The server keeps released extensions working.** Endpoints and payloads a released extension
  uses change additively; a new parameter is optional and an older extension that omits it keeps
  its old behavior.
- **Releases.** The Store accepts an upload only with a higher `version` in `manifest.json`. The
  Store ZIP is built with `extensions/recorder/pack.mjs`; signing keys stay out of git
  (`extensions/signing-keys/*.pem` is ignored).
- **Strings.** Extension strings live in `extensions/recorder/_locales/{en,cs}`; Czech says Klepna
  through the `appName` message (`.claude/rules/i18n.md`).
- **Privacy.** `PRIVACY.md` and `PRIVACY.cs.md` describe what the extension collects; a change in
  what it records, stores or sends updates both.
