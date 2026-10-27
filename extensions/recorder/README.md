# Chatterbox Meeting Recorder

A Chromium extension that records a meeting's audio and streams it to a
Chatterbox instance, where it is transcribed and summarized like any other
recording.

It captures your **microphone** and the audio of a selected browser tab. It can
also capture native Zoom or Teams desktop audio when Chrome offers system audio
for screen sharing on your computer. Audio is mixed by default; an optional
split mode puts your voice on the left and everyone else on the right.

Chromium only (Chrome, Edge, Brave, Vivaldi). Firefox and Safari do not expose
system audio to extensions.

## How it works

With **In-meeting prompt** turned on, an audible meeting shows a banner at the
top of the meeting page. Read the participant notice, then click the recorder
icon at the top right to record that tab directly. The banner shows your actual
keyboard shortcut if assigned. If the icon is hidden, it explains how to pin it
from Chrome's extensions menu. The banner itself does not start direct tab
capture: **Share through Chrome’s dialog** keeps the existing picker path.

1. In the popup, read the short participant reminder and click
   **Consent confirmed · Record this tab**. This records the current tab directly,
   whether or not a meeting platform is detected.
2. To choose a different source, click **Record another screen or app**. Chrome's
   picker opens in a large window centered over the browser, then the window
   narrows after you choose. For a desktop meeting app, choose **Entire screen**
   and enable **Share system audio** if Chrome offers it. The extension keeps
   only audio. The recorder window shows microphone and source levels; you can
   minimize it. Closing it stops capture and uploads the saved chunks. If Chrome
   cannot share screen audio, use the meeting's browser version. Starting from a
   notification or the microphone permission window also uses the picker. If
   Chrome refuses direct capture of a tab, the picker opens instead.
3. Audio is encoded in 5-second slices, encrypted with a server-issued
   per-recording key before it is written to browser storage, and uploaded to
   Chatterbox as it is captured.
4. On stop, the server assembles the slices, remuxes them to Ogg/Opus, and
   creates a recording. The popup shows upload progress, then confirms when
   Chatterbox has saved the recording. It returns to the ready screen and opens
   the new recording in an existing Chatterbox tab, or a new tab if none is open.
   You can download a playable copy from that authenticated recording page.

Choose **Target folder in Chatterbox** before starting, or change it while
recording in the popup, recorder window, or in-page recording pill. **File later**
leaves it unfiled. The selected folder survives interrupted uploads and is
remembered for the next recording. Older servers show the start folder read-only.
The pill also shows elapsed time and **Stop**, and its red dot collapses or
expands the controls. When capture stops, it briefly confirms that upload
continues in the extension. If a changed folder is unavailable when saving, the
server uses the start folder instead.

Because uploads are incremental and buffered in the browser's private file
system, a dropped connection or a closed tab loses seconds, not the meeting.
The server keeps unfinished capture keys for up to 30 days after activity so
encrypted chunks can be replayed after an outage. The buffer is not a playable
offline copy, and a browser profile loss can make it unrecoverable.

Before pairing or recording, the extension shows a data-use disclosure and
requires your agreement. See the [extension privacy policy](PRIVACY.md)
([Czech](PRIVACY.cs.md)) for
details about the encrypted browser buffer, recorder key, downloads, and the
responsibilities of the server operator.

## Install and connect

1. Install [Chatterbox Meeting Recorder from the Chrome Web Store](https://chromewebstore.google.com/detail/chatterbox-meeting-record/pojdfnhpfijfolehkjidbomgjemonkge)
   in desktop Chrome or a compatible browser, and pin it to the toolbar.
2. Open Chatterbox, click the recorder's toolbar icon, then **Connect to** this
   server. Options opens with three steps: read the three-point data-use notice
   and click **I understand and agree**; click **Allow microphone** and choose
   the first, persistent option; click **Connect to** the displayed server and
   allow site access. Consent has no checkbox. Each permission has its own click.
3. The Chatterbox tab sends the key automatically. The extension shows
   **The extension is ready** and **Back to Chatterbox**. If your server has not
   been updated, after five seconds setup offers to focus the Chatterbox tab:
   click **Connect** there. A key from the selected tab and server completes
   setup without another confirmation; other proposals still require one.

If Options was opened directly, it finds open recorder settings or onboarding
tabs marked with `?section=recorder`. One tab is preselected; several show a
host-and-title choice. With no match, enter your Chatterbox address. Setup
normalizes it to an HTTPS origin, requests access, and opens
`/settings?section=recorder` in a new tab. Sign in there if necessary. The setup
window remains valid for 15 minutes. On older servers, open **Settings → Meeting
Recorder** and click **Connect**. **Enter address and key manually** remains
available at the connection step.

The microphone step shows Chrome's three choices and explains why temporary
permission may expire. Edge and Brave use neutral permanent-access instructions.
**Not now** saves a skipped state across reloads; setup then warns that recordings
will lack your voice and offers **Allow microphone**. Browser blocks link to
microphone settings; OS blocks show macOS or Windows instructions. Managed
browser policies may require an administrator. Other settings appear after setup;
disconnecting reopens only the connection step while microphone access or its
saved skip remains valid.

Meet, Teams and Zoom web use **Prompt** by default, also after updating an
installation with no saved platform choice. Existing choices and server
defaults keep precedence. Other platforms remain **Off** until you or the server
choose otherwise. Updating from 0.2.1 changes the old implicit Off default to
Prompt for Meet, Teams and Zoom web. When a meeting becomes audible, the
in-page banner offers recording instructions if you have enabled it; otherwise
the existing system notification appears. Its **Consent confirmed · Record**
button uses Chrome's audio picker (with the microphone check first if needed).
Choose the meeting tab and enable **Share tab audio**. Clicking the notification
body opens Options at **In-meeting prompt** when meeting-site access is missing;
if access exists but the banner cannot mount, it focuses the meeting tab. **Not now** or the banner's close
button dismisses the prompt for that meeting.

**In-meeting prompt** is optional. Enable it from the one-time popup card,
Options, or the ready screen after the same three setup steps. Chrome requests
access to Google Meet, Zoom web, Microsoft Teams (including
`teams.cloud.microsoft`), Webex and Whereby together. For these seven origins,
Chrome shows the generic warning **Read and change your data on a number of
websites**, rather than a per-site list. The banner reads no page
content and makes no network requests. Turning the switch off removes that
site access and hides the banner. Slack huddles and Jitsi keep their existing
notification path; their access is not requested. Updates open no announcement
tab and add no manifest permissions. Dismissing the popup card hides it for good;
the Options switch stays available.

If the microphone is not allowed, recording waits for you to allow it or choose
**Record without my microphone**. The popup and toolbar badge warn beforehand.
Blocked microphone access shows the Chrome settings path for allowing it again.
An unplugged selected microphone retries the default input. If it still fails,
meeting audio keeps recording with a persistent notification and popup warning
explaining the failure. After deliberately recording without a microphone, you
can dismiss permission reminders in the popup and re-enable them in Options.

## Meeting agendas (0.8.0)

A supporting server advertises `features.agendas: true`. The popup then shows an
Agenda card for a meeting running now or starting within 15 minutes and preselects
its folder. Meet matches by room code on the server; other platforms match by time.
Several matches open a choice instead of selecting one silently.

**Show agenda** opens Chrome's side panel, which stays available while switching
tabs. If Chrome refuses the request, the same page opens in a small extension
window. Preparation shows the outline and task review; **Live meeting** enables
discussed ticks, timestamped hints, notes, quick points and task **Done / Drop**.
Changes save to the server and colleagues' changes refresh every 15 seconds.
Task actions change real tasks and honor their existing permissions. Absorbed
agendas remain read-only. **Open in Chatterbox** opens the full meeting page.

While recording, the panel and popup show which agenda will accompany the
recording. **Another agenda…** offers agendas at the same time or **No agenda**.
The chosen ID survives upload recovery and is sent when the recording completes.
Only an agenda shown before Record or explicitly chosen is sent. Unseen matches
use the server's safe automatic rule unless you confirm a choice during recording.
An agenda's folder applies to this recording only; your default folder stays unchanged.
**No agenda** tells the server to skip automatic attachment. On a server that
ignores this decision, automatic attachment may still apply.
If the selected agenda becomes unavailable, the recording is saved without it
and the completion message explains this.
The optional in-meeting banner adds an Agenda line and the recording pill an
Agenda button; neither reads page content.

With configuration refresh, the extension fetches the next 24 hours of timed
agendas and schedules reminders one minute before each start. Refresh configuration
in Options after adding or rescheduling a meeting to update reminders immediately.
**Remind me of agendas at meeting time** and **Offer agendas in the meeting banner**
are independent Options switches, both on by default. On an older server Options
explains that agendas need a server update; no agenda UI or requests are added to
recording. The only new manifest permission is `sidePanel`.

## Load it for development

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** and select this `extensions/recorder` folder.
4. Open the extension's **Options**, grant microphone access, and pair it with
   your Chatterbox instance (see below).

The unpacked build uses a different ID from the published extension. Set
`NEXT_PUBLIC_RECORDER_EXTENSION_ID=hiipabbdnlhdkgldhkdndmohejoaecnh` when running
Chatterbox against this development build.

No build step is required: Chrome loads the extension's JavaScript directly.
Extension pages use ES modules. The meeting banner and shared folder combobox
use classic scripts in Chrome's isolated world. A static ES-module wrapper
exports the same combobox to the popup and recorder window. This avoids dynamic
imports and keeps banner resources out of `web_accessible_resources`.

## Pairing

Follow **Install and connect** above for setup without copying a key. For manual
pairing, first open the extension's **Options**, read the data-use disclosure,
and agree.
Then in Chatterbox, open **Settings → Meeting Recorder** and generate a recorder key
(a `recordings:write` API key that creates recordings and looks up folder names
to file them, and reads and edits visible agendas on supporting servers, but cannot read recordings). Then either:

- Click **Connect** on that page. A matching active setup stores the key directly;
  without an active setup, confirm the destination in the extension's Options
  page. Chrome may ask for access to that server origin.
- Paste the **server URL** and **key** into the extension's Options, then
  **Save and grant access**. Open tabs of that server detect the extension
  without reloading.

## Packaging

For a Chrome Web Store upload or manual distribution, from the
repository root:

```bash
node extensions/recorder/pack.mjs
```

This writes `dist/chatterbox-recorder-<version>.zip`. The ZIP omits the
development-only manifest `key`, which the Chrome Web Store rejects.

The published Chrome Web Store extension ID is
`pojdfnhpfijfolehkjidbomgjemonkge`, which Chatterbox detects by default.
The `key` in `manifest.json` pins the unpacked development extension ID to
`hiipabbdnlhdkgldhkdndmohejoaecnh`. The matching private key lives outside this
folder in `extensions/signing-keys/` (git-ignored) so Chrome does not warn about
a `.pem` inside the loaded extension; keep it if you ever sign a `.crx`
yourself. Rebuilding with a different key changes the ID, in which case set
`NEXT_PUBLIC_RECORDER_EXTENSION_ID` on the server.

## Permissions, and why

| Permission | Why |
| --- | --- |
| `offscreen` | Keeps the current tab's capture running while the toolbar popup is closed. |
| `desktopCapture` | Opens the screen picker to capture system audio. |
| `tabCapture` | Records the current tab's audio directly, without the screen picker. |
| `sidePanel` | Shows the selected agenda alongside browser tabs after a user click. |
| `alarms` | Agenda reminders one minute before timed meetings, auto-stop quiet timer, upload retry and completion polling, and the daily server-defaults refresh; survives worker suspension. |
| `tabs` | Detects meeting URLs, finds marked recorder setup tabs and their titles for connection, tracks the recording tab, and opens a server-confirmed recording in your Chatterbox tab. |
| `notifications` | "Meeting detected" prompt and "recording sent" confirmation. |
| `storage` | Stores settings, an encrypted recorder token, and recording state. Encrypted audio chunks use the browser's private file system. |
| `scripting` | Registers the pairing relay on your Chatterbox origin and, after optional site access is granted, the isolated meeting banner. |
| optional host access | Granted per server origin for pairing and uploads. The in-meeting prompt separately requests the five meeting platforms together, only when you turn it on. |

Suggested Chrome Web Store explanations for every manifest permission are in
[STORE_SUBMISSION.md](store/STORE_SUBMISSION.md).

## Legal

Recording people can require their consent, and the rules differ by country.
Clicking **Consent confirmed · Record this tab** records your acknowledgement; it does
not obtain consent from other participants. You are responsible for complying
with the laws and meeting-platform terms that apply to you.
