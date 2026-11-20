---
title: The meeting card is a notice and manual recording starts in the extension
date: 2026-11-20
updated: 2026-11-20 10:33
status: accepted
kind: feature
issues: [429]
prs: []
areas: [extensions/recorder/content-meeting.js, extensions/recorder/service-worker.js, extensions/recorder/lib/prompt-icon.js, extensions/recorder/lib/recording-controls.js]
supersedes: [2026-10-22-meeting-recorder-banner, 2026-11-19-recorder-prompt-points-at-icon]
superseded-by: []
relates: []
---

# The meeting card is a notice and manual recording starts in the extension

Recorder 0.9.11 puts manual start controls in the popup or agenda panel. The
meeting card points people to those controls and displays the participant
notice. During capture, the card gives way to the recording pill with two
miniature four-band equalizers.

## Why

Chrome exposes whether the icon is pinned. It withholds its position, and
direct tab capture needs an extension invocation. An arrow on the page can
point at a different toolbar control as the window layout or zoom changes.

### Previous state

In 0.9.10, the card offered the picker and dismissal while the toolbar started
the current tab. A screenshot showed the arrow tip roughly 340 screenshot
pixels to the right of the recorder icon. The icon sat about 350 pixels from
the window edge. The branch for `outerWidth - innerWidth > 40` aimed 14 CSS pixels
inside the layout viewport's edge. At 1:1 scale with aligned edges, the
other branch's 150 CSS-pixel offset would still miss by about 200 pixels.
The cropped screenshot cannot establish what narrowed the viewport.

## Options considered

| Option | Clicks pinned / unpinned | Decision |
| --- | --- | --- |
| A. Notice, then popup | 2 / 3 | Chosen. The available start actions are together. A toolbar click opens the recording UI and the next click confirms consent. |
| B. Direct start without arrow | 1 / 2 | Declined because the toolbar itself starts capture while the alternate-source action still lives elsewhere. The faster start keeps the split. |
| C. Revise the arrow | 1 / 2 | Declined because Chrome's layout calculations cannot locate a particular icon among other pins, side panels, or vertical tabs. Revisit if Chrome exposes icon coordinates. |
| D. Start capture from the card | 2 / 2 best case | Declined because capture would require the browser chooser and a new, verified capture handoff with encrypted recovery. |

## Decision

Choose A. The maintainer required a single place for recording controls.
The notice shows the icon, names the popup button, and illustrates Chrome's
Extensions menu and pin control when the icon is unpinned. The icon retains
its 20-second blink and alternates the highlight with the `REC?` badge.
After the blink, the card points to the badge. The assigned shortcut confirms
consent and starts directly. The close button dismisses the notice for the
current meeting.

Agenda tabs keep opening the agenda panel, and unconfirmed Auto policy still
opens Options. With the policy acknowledged, Auto keeps direct toolbar
start and stop, including auto-stop, and shows no manual recording notice.

## Key technical details

- The worker leaves the manual popup set on prompt tabs. The popup records the
  acknowledgement and requests direct tab capture. Start checks the meeting
  identity again before capture and aborts the new session if the tab changed.
  Successful capture ends the prompt and hands off the icon and badge to the
  recording state.
- An unreachable server keeps only the participant notice and connection
  guidance. The shortcut uses any saved policy acknowledgement. Without one,
  the card must have rendered the consent wording for the current meeting while
  reachable. An authorized shortcut uses the regular connection error path
  during an outage. Recovery can use a blink window whose first frame never
  painted. Existing capture still offers Stop and preserves its encrypted audio
  buffer.
- The expanded pill's isolated top-frame script subscribes while the tab that
  started the recording is visible. The pill shows the levels of the recording
  in progress, including any source selected through the picker. The worker
  checks the session and the launching tab's meeting identity, sends numeric
  levels at most eight times a second, and closes the port when capture stops
  before the audio buffer flushes. The pill retries an unexpected disconnect
  with a short backoff while it remains eligible. Each channel gets
  its overall dB level and four band peaks from the capture analyser
  (100–300 Hz, 300 Hz–1 kHz, 1–3 kHz, 3–8 kHz). The pill uses the overall level
  when a channel's band data is absent. Its four bars return to a 2 px floor
  when levels stop. The popup keeps its existing overall dB meters.
- The same extension behavior applies to self-hosted and hosted servers
  using existing permissions and endpoints. Older servers keep the same
  read-only target folder behavior.

## Verification

- `src/tests/regressions/429-meeting-card-notice.test.js` covers five notice
  variants, the popup handoff, the blink lifecycle, and the level subscription
  and targeting. Nine tests failed against 0.9.10 before implementation.
  `src/tests/recorder/capture-host.test.js` checks band measurement for both
  channels, and the pill regression covers separate heights and the fallback.
  Cross-review cases cover same-tab navigation during session creation,
  outage-first shortcut consent, a lost toolbar click, blink restoration,
  the picker’s launching tab, and meter retry and stop handling.

- Headed Chromium 159 with the unpacked extension and local stubs verified
  popup routing, both pin states and the unreachable notice. The meter check
  fed the offscreen capture host the stub page's PCM and a synthetic microphone.
  The four bands moved independently on both channels, and each collapse, tab
  hide and Stop closed the port. Each equalizer was 14 px tall. At 420 px the
  pair measured 64 px across, and Stop stayed on the same 47.5 px-high pill
  as at desktop width. Stop stayed on the row when the
  connection notice appeared below it. Reduced motion disabled meter
  transitions. Native tab capture was unavailable in the CDP run.

## Consequences & open follow-ups

Manual recording takes two clicks with a pinned icon and three from the
Extensions menu. The assigned shortcut remains a one-press path.

## Related work

- [Toolbar arrow and blinking icon](2026-11-19-recorder-prompt-points-at-icon.md)
  is superseded for arrow targeting and the manual toolbar flow. The blink,
  badge copy and illustrated unpinned steps carry forward.
- [Meeting Recorder in-meeting banner](2026-10-22-meeting-recorder-banner.md)
  is superseded for manual one-click toolbar start and the card's start
  controls. The pill, keyboard command, optional meeting-site access and
  notification fallback carry forward.

## Timeline

- **2026-11-20** The maintainer chose the notice and popup flow for #429.
