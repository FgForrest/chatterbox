---
title: Meeting Recorder as a Chromium extension with encrypted buffering, released ahead of the servers it talks to
date: 2026-10-21
updated: 2026-10-22 17:00
status: accepted
kind: feature
issues: []
prs: [108, 123, 124, 125, 130, 132, 163, 180, 188, 193, 195, 198, 207, 213]
areas: [extensions/recorder, src/app/api/v1/recording-sessions, src/app/api/v1/recorder, src/lib/recording-sessions, src/lib/recorder, content/docs/guides/meeting-recorder.mdx]
supersedes: []
superseded-by: []
relates: [2026-10-19-employee-first-onboarding, 2026-10-22-meeting-recorder-banner]
---

# Meeting Recorder as a Chromium extension with encrypted buffering, released ahead of the servers it talks to

The Chatterbox Meeting Recorder is a Chromium extension (Chrome, Edge, Brave, Vivaldi) that records
a meeting's audio (a browser tab, or desktop audio through Chrome's share dialog) together with the
microphone, and streams it in 5-second slices to the user's own Chatterbox server, where it becomes
an ordinary recording. Every slice is encrypted with a server-issued per-recording key before it is
written to browser storage. The extension is published through the Chrome Web Store, which updates
installs before most servers upgrade, so every new server call must degrade on released servers.
The line ran from the first extension PR (from an external contributor, encryption folded in before
merge) through Store packaging, one-pass and then three-step setup, the microphone and meeting-prompt
rules, and version 0.6.0, which repaired Chrome's share dialog and records the current tab directly.

## Why

Online meetings run in Google Meet, Teams or Zoom, often in the browser, and their recordings should
land in the same pile as recorder uploads. An extension can capture the tab's audio and the
microphone where the meeting already runs. The constraints that shaped every later decision:

- **The Chrome Web Store.** Its user-data policy asks for strong encryption of data at rest, it
  wants the narrowest permissions, it rejects a manifest with a `key`, and it updates installed
  extensions on its own schedule, ahead of self-hosted servers.
- **Chrome's capture rules.** Direct tab capture needs an invocation (the toolbar icon or the
  keyboard shortcut); a notification button or `chrome.action.openPopup()` is not one, so any other
  start goes through Chrome's "Choose what to share" dialog. On macOS and Linux Chrome draws that
  dialog inside the requesting window.
- **Long meetings.** A multi-hour recording must never be assembled in browser memory; a dropped
  connection must lose seconds, not the meeting.
- **Self-host.** No new secret or deploy-surface change for the server operator.

## Decisions taken

| Date | Decision | Why | Detail |
|------|----------|-----|--------|
| 2026-10-13 | Record in a Chromium extension, Chromium only | Meetings run in browser tabs; Firefox and Safari do not expose system audio to extensions. No other recording surface was on the table: the extension arrived as an external contributor's PR | `extensions/recorder/` |
| 2026-10-13 | At-rest encryption lands inside the first PR, encrypted-only, with no plaintext recorder path | The recorder was on neither `dev` nor `main`, so nobody used it yet; merging first would ship a plaintext-only recorder API in the next release | PR #108 |
| 2026-10-13 | Each capture gets a server-generated AES-256-GCM key, stored under the existing `ENCRYPTION_KEY`, bound to the user, the client recording id and the recorder key, retired atomically on completion, expiring 30 days after last activity | Session creation already precedes capture, so the extension never needs a key offline; no new secret, no provisioning, no rotation; user binding stops a copied profile from being replayed into another account | `src/lib/recording-sessions/chunk-crypto.ts`, `extensions/recorder/lib/chunk-crypto.js` |
| 2026-10-13 | Automatic plaintext copies in Downloads removed, with the `downloads` permission; the completion notice opens the authenticated recording page | Under encryption the local copy appeared only after the server had succeeded, so it no longer protected against server failure, and it drove most of the plan's complexity | PR #108 |
| 2026-10-13 | The recorder token is encrypted under a non-exportable Web Crypto key, described as Store compliance, not protection | Chromium keeps the key bytes in the same profile; code inside the extension can call the vault anyway | `extensions/recorder/lib/token-vault.js` |
| 2026-10-19 | No host access to the upstream Riffado domain; `externally_connectable` only for `localhost`; every other origin pairs through the relay after the user grants access to it | Pairing already asks for the chosen server's origin, and the Store wants the narrowest permissions; `pack.mjs` strips the manifest `key` for the Store ZIP | PR #163 |
| 2026-10-19 | The pairing relay runs only on the setup or paired origin | A grant "on all sites" made in Chrome's own menu installed the relay on every tab, which could read the extension id and the server address (review finding) | PR #180 |
| 2026-10-19 | Microphone checked by permission state and a real open of the device before each start, never by audio activity | People missed the microphone grant and recorded without their own voice; silence must never prompt. A granted microphone that fails to open retries the default input, then keeps the meeting audio with a lasting warning, because the first draft lost the whole recording | PR #180, `extensions/recorder/lib/microphone.js` |
| 2026-10-19 | The meeting prompt ("Record" / "Not now") is the default for Meet, Teams and Zoom web; other platforms stay Off; explicit choices and server defaults keep precedence | The maintainer expected a prompt when a meeting starts; every platform had defaulted to Off and the prompt mode only said "click the icon" | PR #180 |
| 2026-10-20 | A start from the meeting notice needs no separate checkbox window: the button wording ("Consent confirmed · Record") is the consent | A participant checkbox had been ruled out before; 0.3.0 reintroduced it in an extra window | PR #193 |
| 2026-10-20 | Every new or changed server call in the extension must work against released servers | The Store updates the extension first; 0.4.0 nearly saved the first folder of a legacy full list as the remembered folder | PRs #195, #207, #213 |
| 2026-10-20 | The recorder key lists only folders it can file into; folder search is server-side (`?q=`, `?id=`) | A key described as write-only received every folder path, and hundreds of Organization folders made a plain select unusable | PR #195, `src/app/api/v1/recorder/folders/route.ts` |
| 2026-10-20 | Setup is three steps at the top of the options page (consent, microphone, connect); the second pairing confirmation is skipped only for a key from the same setup tab and server within 15 minutes, with site access granted and the setup page still open | Users bounced between the app and the extension four times; any other key keeps the confirmation that answers the pairing-hijack finding of PR #108's review | PR #207 |
| 2026-10-21 | The recorder window opens at 800 x 680, centered over the browser window, while Chrome's share dialog is open, and fits its content only after a source is chosen | 0.4.1 fitted the window to its content before the dialog opened; on macOS and Linux Chrome clipped the dialog to about 200 px and nobody could start a desktop recording | PR #213, `extensions/recorder/lib/picker-window.js` |
| 2026-10-21 | The popup records the current tab directly for any tab; "Record another screen or app" opens the dialog; the notification and the microphone-first start keep the dialog | A toolbar click is an invocation for whatever tab is current, so the dialog is needed only when Chrome refuses direct capture | PR #213 |
| 2026-10-21 | The target folder can change during recording and is sent once with completion (optional `folderId`), announced by `recording_folder_override` in the recorder config; read-only on older servers | One request at the end files the recording exactly once and adds no traffic during the meeting | PR #213, `src/lib/recorder/config.ts` |

## Rejected outright

| Option | Rejected because | Revisit if |
|--------|------------------|------------|
| Merge the extension first, encrypt in a follow-up | The next release would put a plaintext-only recorder API on self-hosted servers; the Store extension would then have to fall back to plaintext or refuse those servers | Never |
| A deployment key pair (the extension encrypts to the server's public key) | A new secret type with PEM provisioning (a deploy-surface change), key rotation and ids, a lost-key scenario, distribution to every hosted process; as first written the server unwrapped any wrapped key a recorder presented, so a copied profile plus token could be replayed into another account | Recording has to start while the server is unreachable |
| Keep the `always` local-copy default | It no longer protects against server failure, and it assembled the whole recording in a Blob, base64-encoded it and skipped files over 200 MiB | Never |
| Fail closed when `storage.local.setAccessLevel` fails | Support for the `local` area at the extension's minimum Chrome version was unconfirmed, and the gate protects nothing secret once the token is encrypted | Never |
| Required host access for the upstream Riffado domain | Unneeded for pairing; the Store asks for the narrowest permissions | Never |
| Judge the microphone by audio activity, or a "silent for 5 minutes" hint | The maintainer ruled that silence never prompts; the quiet hint was offered and not requested. A granted but muted or wrong input therefore shows only as a flat "You" meter | Users keep recording with a muted microphone |
| Start tab capture straight from the meeting notification | Chrome refuses: a notification is not an invocation ("Extension has not been invoked for the current page") | Chrome changes the invocation rule |
| Fit the recorder window to its content from the start | Clips Chrome's share dialog on macOS and Linux | Chrome draws the dialog as its own window everywhere |

## Key technical details

- Extension: `extensions/recorder/` (`service-worker.js`, `offscreen/`, `picker/`, `popup/`,
  `options/`, `lib/`). Store ZIP: `node extensions/recorder/pack.mjs`; the unpacked development
  build keeps the manifest `key` so its id stays fixed.
- Server: `src/app/api/v1/recording-sessions/` (create, chunks, complete, recover),
  `src/app/api/v1/recorder/` (config, folders, confirm-pairing), `src/lib/recording-sessions/`
  (decryption per chunk, finalize job, sweeper). Migrations 0107-0110.
- The server advertises `encrypted_recording_protocol: 1` and `recording_folder_override: true` in
  `/api/v1/recorder/config`. The extension refuses servers without the encrypted protocol, and falls
  back for each later capability it does not see.
- `ENCRYPTION_KEY` must stay available while unfinished captures exist; their keys live up to 30 days
  after activity so encrypted chunks can be replayed after an outage.
- The encrypted buffer in the browser's private file system is kept until the server confirms
  completion. It is not a playable offline copy, and a lost browser profile makes it unrecoverable.
- The recorder key creates recordings and looks up folder names for filing; it never reads
  recordings. Under `AUTHZ_MODE=idp` it works only while its holder has `use`.
- A folder refused at completion completes again with the start folder.
- Long folder paths ellipsize from the start (right-to-left) and need a trailing left-to-right mark,
  or a final "." or ")" jumps to the front. It looks like stray markup; it is deliberate.

## Verification

- PR #108: 2,897 tests passed; a browser Web Crypto to server AES-GCM fixture covers decryption and
  rejects index and tag tampering.
- Regression tests under `src/tests/regressions/108-recorder-*.test.js` (encryption, pairing,
  microphone failures, single-click start, token vault, retry, finalize idempotency, and more).
- PR #180: 491 recorder and regression tests; English and Czech catalogs at parity (177 keys each).
- PR #195: `src/tests/recorder/folders-route.test.ts` and `folder-picker.test.js`, including a server
  that answers with every folder; whole suite 6,195 passed.
- PR #198: `src/tests/recorder/fit-window.test.js`; PR #213: `picker-window.test.js` and
  `src/tests/recording-sessions/complete-folder.test.ts`; whole local DB suite 6,633 passed.
- Chrome behavior (tab capture needs an invocation; the service worker's microphone permission query
  matches the extension pages) verified in Chrome for Testing 156 with the unpacked extension.
- Not covered by automation: Chrome's native permission prompts and share dialog. Each release lists
  manual checks for macOS and Linux in its PR.

## Consequences & open follow-ups

- Server-side streaming for large audio was split out of PR #108: the authenticated web audio route
  can still buffer a whole recording in memory for playback or download, for every recording source.
- On Linux only a Chrome tab carries audio; desktop Teams or Zoom apps cannot be recorded there with
  any approach.
- A start from the meeting notification still goes through Chrome's dialog. An in-page meeting
  banner pointing at the toolbar icon was being built as the next version and had not merged.
- Extension changes reach users only through Store review, so a broken release (as 0.5.0 was for the
  share dialog) stays out for at least one review cycle.
- Folder changes during recording need the server from PR #213; until that release, servers keep the
  start folder.

## Related work

- [2026-10-19-employee-first-onboarding](../2026-10-19-employee-first-onboarding.md): the setup
  wizard's recorder step, and the request that led to one-pass pairing, the microphone check and the
  meeting prompt.
- [2026-10-22-meeting-recorder-banner](../2026-10-22-meeting-recorder-banner.md): 0.7.0 replaces the meeting notification with an in-page banner and a recording pill.

## Timeline

- **2026-10-09**: first extension PR (#108) opened by an external contributor.
- **2026-10-13**: encryption plan reviewed twice; encrypted-only, server-issued keys and no automatic
  download decided; PR #108 merged, followed by desktop-capture and progress fixes (PRs #123, #124,
  #125).
- **2026-10-14**: Store submission assets (PR #130).
- **2026-10-15**: install and connect the published extension from Settings (PR #132).
- **2026-10-19**: Store-ready package without upstream host access (PR #163); 0.3.0 with one-pass
  pairing, the microphone check and the meeting prompt (PR #180).
- **2026-10-20**: 0.3.0 docs (PR #188); 0.3.1 notice start (PR #193); 0.4.0 folder search and
  fileable folders (PR #195); 0.4.1 window fitting (PR #198); 0.5.0 three-step setup (PR #207).
- **2026-10-21**: 0.6.0 picker window, current-tab recording and folder change during recording
  (PR #213).
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
