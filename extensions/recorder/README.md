# Riffado Meeting Recorder

A Chromium extension that records a meeting's audio and streams it to a
Riffado instance, where it is transcribed and summarized like any other
recording.

It captures **system audio** (so it works with meetings in a browser tab and
with native Zoom or Teams desktop clients) plus your **microphone**, mixed
into a two-channel file: your voice on the left, everyone else on the right.
That split lets Riffado tell "you" from "the others" without guessing.

Chromium only (Chrome, Edge, Brave, Vivaldi). Firefox and Safari do not expose
system audio to extensions.

## How it works

1. You click **Record** and confirm the participant notice.
2. Chrome's picker opens; you choose **Entire screen** and enable
   **Share system audio**. The extension keeps only the audio.
3. Audio is encoded in 5-second slices, buffered locally, and uploaded to
   Riffado as it is captured.
4. On stop, the server assembles the slices, remuxes them to Ogg/Opus, and
   creates a recording. A local `.webm` copy is saved to your Downloads
   (configurable).

Because uploads are incremental and buffered in the browser's private file
system, a dropped connection or a closed tab loses seconds, not the meeting.

## Load it for development

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** and select this `extensions/recorder` folder.
4. Open the extension's **Options**, grant microphone access, and pair it with
   your Riffado instance (see below).

No build step is required: the extension is plain ES-module JavaScript loaded
directly by Chrome.

## Pairing

In Riffado, open **Settings → Meeting Recorder** and generate a recorder key
(a `recordings:write` API key that cannot read your library). Then either:

- Click **Send to extension** on that page (works once the extension has been
  granted access to the server's origin), or
- Paste the **server URL** and **key** into the extension's Options.

## Packaging

For an unlisted Chrome Web Store upload or manual distribution, from the
repository root:

```bash
node extensions/recorder/pack.mjs
```

This writes `dist/riffado-recorder-<version>.zip`.

The extension ID is pinned by the `key` in `manifest.json`:
`hiipabbdnlhdkgldhkdndmohejoaecnh`. It is the same whether loaded unpacked,
packed, or from the store, and the Riffado web app uses it to detect and
message the extension. The matching private key lives outside this folder in
`extensions/signing-keys/` (git-ignored) so Chrome does not warn about a
`.pem` inside the loaded extension; keep it if you ever sign a `.crx`
yourself. Rebuilding with a different key changes the ID, in which case set
`NEXT_PUBLIC_RECORDER_EXTENSION_ID` on the server.

## Permissions, and why

| Permission | Why |
| --- | --- |
| `offscreen` | MV3 only allows `getUserMedia`/`MediaRecorder` in an offscreen document. |
| `desktopCapture` | Opens the screen picker to capture system audio. |
| `tabCapture` | Records a detected meeting tab's audio directly, without the screen picker. |
| `alarms` | Auto-stop quiet timer and the daily server-defaults refresh; survives worker suspension. |
| `tabs` | Detects meeting URLs and knows which tab a recording belongs to. |
| `notifications` | "Meeting detected" prompt and "recording sent" confirmation. |
| `downloads` | Saves the local copy. |
| `storage` | Stores settings and recording state. |
| `scripting` | Registers the pairing relay on your Riffado origin. |
| optional host access | Granted per server origin so the extension can upload only there. |

## Legal

Recording people can require their consent, and the rules differ by country.
The participant-notice confirmation records that you were reminded before each
recording; it is not itself consent. You are responsible for complying with the
laws and meeting-platform terms that apply to you.
