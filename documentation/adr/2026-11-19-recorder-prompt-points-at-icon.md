---
title: Point the meeting prompt at the toolbar and blink the pinned recorder icon
date: 2026-11-19
updated: 2026-11-20 09:52
status: superseded
kind: fix
issues: [421]
prs: [424]
areas: [extensions/recorder/content-meeting.js, extensions/recorder/service-worker.js, extensions/recorder/lib/prompt-icon.js]
supersedes: []
superseded-by: [2026-11-20-recorder-meeting-card-is-a-notice]
relates: [2026-10-22-meeting-recorder-banner]
---

# Point the meeting prompt at the toolbar and blink the pinned recorder icon

The in-meeting card uses an arrow and a ring to guide users toward the toolbar. When the icon is
pinned, a short blink marks its actual position. When it is unpinned, the card illustrates the
extensions menu and the arrow points toward its puzzle button.

**Superseded in part** by [The meeting card is a notice](2026-11-20-recorder-meeting-card-is-a-notice.md).
The new decision removes the arrow and rings and changes the manual recording route. The 20-second blink, its badge alternation and pin guidance still hold.

## Why

Chrome 159 still requires an extension invocation for direct tab capture. A toolbar click or keyboard
shortcut qualifies. Clicking inside the meeting page, even after granting site access, opens
Chrome's sharing dialog if capture starts there. Chrome also exposes pin state without exposing
toolbar coordinates.

### Previous state

The card explained the toolbar invocation in a sentence. The most prominent action opened
Chrome's picker, so users reached the picker when they meant to record the tab directly.

## Options considered

| Design | Benefit | Decision |
| --- | --- | --- |
| Existing card | Preserves the familiar layout. | Declined because the dialog action draws attention away from direct capture. |
| A, bubble under the icon | Puts instructions close to the expected icon. | Declined because the position is estimated and the bubble can appear under a different toolbar control. |
| B, button followed by an arrow | Gives the card an obvious primary button and explains where to click next. | Declined because it adds a click before the extension invocation and dims the meeting during guidance. |
| C, full-width strip | Leaves most of the meeting page open. | Declined because the strip resembles a routine information bar and still assumes the icon is directly above the arrow. |
| D and F, unpinned menu guidance | Shows the two steps and the pin next to the recorder name. | F carries the guidance into the immediate, undimmed card. D uses a dimmed page. |
| E, immediate arrow for a pinned icon | Makes the toolbar action visible as soon as the prompt appears. | Chosen with F. The direct capture route takes one click and the meeting page stays usable. |

## Decision

Show E or F immediately based on Chrome's pin setting. The arrow supplies a direction and the
temporary toolbar highlight identifies the precise icon. A toolbar layout API could replace the
estimate in a future design.

## Key technical details

- `content-meeting.js` draws the arrow in the closed shadow root and recomputes it on resize.
- `lib/prompt-icon.js` pre-renders the two frames and blinks for up to 20 seconds. Session storage
  records tab overrides so a new worker can restore them after suspension. Chrome draws the REC?
  badge over most of the 16 px icon. The highlighted frame hides the badge to expose the whole
  highlight, and the normal frame shows REC?.
- The worker sends the blink deadline with the prompt. The card says "click the blinking icon" only
  until then, and afterwards (or when Chrome cannot blink the icon) points at the icon with the REC?
  badge, so the copy never promises a blink that is not happening.
- The toolbar opens the agenda panel on agenda tabs and Options when automatic recording policy
  needs acknowledgement. The alternate-source button uses the existing picker route.

## Verification

- Recorder tests in `src/tests/recorder/meeting-banner.test.js` and
  `src/tests/recorder/meeting-prompt-worker.test.js` cover geometry and the icon and badge lifecycle,
  including an in-flight badge write at recording start. The worker-restart test covers the icon
  repair with a stubbed badge restore.
- Headless Chromium 159 against a stub meeting page and API verified both pin states in both
  colour schemes, live pin changes, corner targeting after a 200 px reduction in viewport width,
  reduced motion, the agenda card and the HTTP 403 notice.
  Chrome accepted both icon frames and restored the normal icon on unpin, dismissal and navigation.
- Headed Chromium on Xvfb showed the highlighted icon without a badge, the normal icon with REC?,
  and the normal icon with REC? after 20 seconds. On a 40 × 40 px toolbar crop, the summed absolute
  RGB difference between the two visible frames rose from 20,542 to 133,503, matching the prototype.

## Consequences & open follow-ups

The arrow's aim varies with toolbar layout. In a 1280 px headed window with one pinned extension
it pointed at the icon and, when unpinned, at the puzzle button. A temporary sign-in chip moved the
icon about 260 px to the left, and each further pinned extension moves it too, which is why the
blink marks the exact spot. On narrow viewports the card carries the instructions on its own. The ring uses a static outline when the user prefers reduced motion.

## Related work

- [Meeting Recorder in-meeting banner](2026-10-22-meeting-recorder-banner.md) established the toolbar
  invocation, picker and notification behavior used by this design.

## Timeline

- **2026-11-19** The maintainer approved E and F for issue #421.
- **2026-11-19** After a real toolbar showed the REC? badge hiding the highlight, the maintainer chose
  to alternate the badge with the highlighted frame and kept the 20-second window.
