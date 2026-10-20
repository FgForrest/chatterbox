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

1. In the popup, read the short participant reminder and click
   **Consent confirmed · Record**. This is the manual recording confirmation.
2. On a detected meeting tab, Chrome captures that tab's audio directly. For
   another browser tab, select it in Chrome's picker. For a desktop meeting
   app, choose **Entire screen** and enable **Share system audio** if Chrome
   offers it. The extension keeps only the audio. A small recorder window stays
   open during desktop capture and shows microphone and meeting audio levels;
   you can minimize it. Closing it stops the recording and uploads the saved
   chunks. If Chrome says screen audio is unavailable, use the meeting's
   browser version instead.
3. Audio is encoded in 5-second slices, encrypted with a server-issued
   per-recording key before it is written to browser storage, and uploaded to
   Chatterbox as it is captured.
4. On stop, the server assembles the slices, remuxes them to Ogg/Opus, and
   creates a recording. The popup shows upload progress, then confirms when
   Chatterbox has saved the recording. It returns to the ready screen and opens
   the new recording in an existing Chatterbox tab, or a new tab if none is open.
   You can download a playable copy from that authenticated recording page.

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
notification asks whether to record it. **Record** opens the participant notice
and microphone check, followed by Chrome's audio picker. Choose the meeting tab
and enable **Share tab audio**. **Not now** dismisses the prompt for that tab.

If the microphone is not allowed, recording waits for you to allow it or choose
**Record without my microphone**. The popup and toolbar badge warn beforehand.
Blocked microphone access shows the Chrome settings path for allowing it again.
An unplugged selected microphone retries the default input. If it still fails,
meeting audio keeps recording with a persistent notification and popup warning
explaining the failure. After deliberately recording without a microphone, you
can dismiss permission reminders in the popup and re-enable them in Options.

## Load it for development

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** and select this `extensions/recorder` folder.
4. Open the extension's **Options**, grant microphone access, and pair it with
   your Chatterbox instance (see below).

The unpacked build uses a different ID from the published extension. Set
`NEXT_PUBLIC_RECORDER_EXTENSION_ID=hiipabbdnlhdkgldhkdndmohejoaecnh` when running
Chatterbox against this development build.

No build step is required: the extension is plain ES-module JavaScript loaded
directly by Chrome.

## Pairing

Follow **Install and connect** above for setup without copying a key. For manual
pairing, first open the extension's **Options**, read the data-use disclosure,
and agree.
Then in Chatterbox, open **Settings → Meeting Recorder** and generate a recorder key
(a `recordings:write` API key that creates recordings and looks up folder names
to file them, but cannot read recordings). Then either:

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
| `offscreen` | Keeps a detected meeting tab's capture running while the toolbar popup is closed. |
| `desktopCapture` | Opens the screen picker to capture system audio. |
| `tabCapture` | Records a detected meeting tab's audio directly, without the screen picker. |
| `alarms` | Auto-stop quiet timer, upload retry and completion polling, and the daily server-defaults refresh; survives worker suspension. |
| `tabs` | Detects meeting URLs, finds marked recorder setup tabs and their titles for connection, tracks the recording tab, and opens a server-confirmed recording in your Chatterbox tab. |
| `notifications` | "Meeting detected" prompt and "recording sent" confirmation. |
| `storage` | Stores settings, an encrypted recorder token, and recording state. Encrypted audio chunks use the browser's private file system. |
| `scripting` | Registers the pairing relay on your Chatterbox origin. |
| optional host access | Granted per server origin so the extension can upload only there. |

Suggested Chrome Web Store explanations for every manifest permission are in
[STORE_SUBMISSION.md](store/STORE_SUBMISSION.md).

## Legal

Recording people can require their consent, and the rules differ by country.
Clicking **Consent confirmed · Record** records your acknowledgement; it does
not obtain consent from other participants. You are responsible for complying
with the laws and meeting-platform terms that apply to you.
