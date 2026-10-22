---
title: Meeting Recorder 0.7.0 asks inside the meeting page and points at its own icon, because only an extension invocation records a tab without Chrome's dialog
date: 2026-10-22
updated: 2026-10-22 17:00
status: proposed
kind: feature
issues: []
prs: []
areas: [extensions/recorder/service-worker.js, extensions/recorder/lib/platforms.js, extensions/recorder/manifest.json, extensions/recorder/popup/folder-combobox.js, extensions/recorder/PRIVACY.md]
supersedes: []
superseded-by: []
relates: [2026-10-21-meeting-recorder-extension]
---

# Meeting Recorder 0.7.0 asks inside the meeting page and points at its own icon, because only an extension invocation records a tab without Chrome's dialog

When the extension detects a meeting tab, it asked through a system notification whose "consent
confirmed, record" button opened Chrome's screen-sharing dialog, which makes no sense for the tab the
meeting is already in. Version 0.7.0 replaces the notification with a Klepna-styled banner inside the
meeting page. The banner tells the user to click the extension's icon (or its keyboard shortcut),
which records the tab with no dialog; while the banner shows, that click starts recording at once; a
recording pill then shows the time, the target folder (changeable) and Stop. Decided on 2026-10-22;
built on a branch, not merged or uploaded to the Store.

## Why

- **Chrome's rule:** an extension may capture a tab without the sharing dialog only after an
  invocation of the extension: a click on its toolbar icon, its keyboard command, or its context-menu
  item. A notification click, `chrome.action.openPopup()` and clicks inside a content script do not
  count (verified on 2026-10-20). So the notification path always fell back to the desktop-capture
  dialog.
- **The maintainer's report:** the prompt offers only "Consent acquired, record" and "Do not record",
  the first opens Google's sharing dialog, yet the prompt appears only when the meeting is in the
  current tab, so nothing needs sharing; and the prompt looks like a system dialog.

### Previous state

0.6.0 recorded the current tab directly from the popup (an invocation) and kept the sharing dialog for
"record another screen or app"; the meeting prompt was still the system notification with the dialog
behind its button (see the recorder campaign record).

## Options considered

The three options put to the maintainer:

### Option A: a banner inside the meeting page that points at the icon (chosen)

- **Pros:** the one-click start the rule allows; Klepna's own look instead of an OS notification;
  room for the participant notice and a recording pill.
- **Cons:** needs site access to the meeting sites, requested once by the user, and an updated Store
  justification and privacy text.

### Option B: keep the notification, but its button only brings the tab forward and flashes the badge (declined)

- **Rejected because:** one more click than A, and the prompt stays OS-styled.

### Option C: keep the dialog and fix the wording (declined)

- **Rejected because:** it keeps the dialog that makes no sense for the current tab.

The maintainer first asked whether the banner needs a new permission approved by Google. It does not:
the extension already declares optional access to all HTTPS sites (`optional_host_permissions`),
which pairing uses, and every supported meeting site falls inside it. The manifest's permission list
does not change, so existing installs are not disabled on update; only the Store justification and
`PRIVACY.md` / `PRIVACY.cs.md` change.

## Decision

**Chosen: A, as version 0.7.0** (the maintainer: "it will be version 0.7.0"), with his answers to
the design's five questions, all yes:

| | Ruling |
|---|---|
| a | One-click start: while the banner is visible, the icon click (or shortcut) starts recording this tab; the banner's participant notice counts as consent. |
| b | A recording pill with elapsed time, the target folder and Stop; the target folder can be changed from the pill after recording starts, with the popup's search and the same server rule. |
| c | One permission prompt for all five meeting platforms (Meet, Zoom web, Teams, Webex, Whereby). |
| d | The system notification stays as the fallback for people who do not turn the banner on, with a line pointing to the new prompt. |
| e | Nothing opens on update: users opt in through a one-time card in the popup, a switch in settings, or the last setup step. |

## Key technical details

As built on the branch (not on `dev`):

- The meeting origins come from `lib/platforms.js` (one source) and are requested with
  `chrome.permissions.request` from a click in an extension page; on grant the banner script is
  registered and injected into open meeting tabs, on removal unregistered.
- The banner lives in a closed shadow root, reads nothing from the page and sends nothing to it; it
  talks only to the service worker. Messages from it are accepted only from the top frame of the
  armed or recording meeting tab.
- One-click start works by clearing that tab's action popup while the banner shows, so the click
  reaches the existing auto-start path; the popup is restored when the banner goes away.
- **Compatibility:** no server change; the pill's folder change degrades to read-only on servers
  without the folder-override capability, as the popup's does.

## Verification

Not merged. On the branch: recorder and regression tests 855 passed, 0 failed; the manifest differs
from `dev` only in its version. Native permission prompts, real toolbar and shortcut invocations and
the Store review were not exercised in a real browser yet.

## Consequences & open follow-ups

- The Store upload needs the updated justification text and a new screenshot.
- Users who never opt in keep the notification path and its dialog.

## Related work

- [2026-10-21-meeting-recorder-extension](2026-10-21-meeting-recorder-extension/README.md): the
  extension's earlier decisions (encrypted buffering, compatibility with released servers, current-tab
  recording in 0.6.0) that this builds on.

## Timeline

- **2026-10-20**: verified that only an extension invocation records a tab without the dialog.
- **2026-10-22**: the meeting prompt reported; option A chosen as 0.7.0; design approved with a to e;
  built on a branch.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
