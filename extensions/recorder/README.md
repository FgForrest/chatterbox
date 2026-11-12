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
keyboard shortcut if assigned. On agenda tabs the icon opens the agenda and recording controls; recording starts from its consent button. If the icon is hidden, it explains how to pin it
from Chrome's extensions menu. The banner itself does not start direct tab
capture: **Share through Chrome’s dialog** keeps the existing picker path.

1. In the popup, click
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

On supporting servers, an accessible restricted Organization folder shows an olive
folder-lock icon in the target chips and folder choosers in the popup, agenda
panel (or fallback window), recorder window, full-page picker and in-page
recording pill. The marker appears after folder results load. Inaccessible folders
are omitted. If a remembered folder is no longer available, the chooser asks you
to select another folder or leave the recording unfiled. Older servers without
the optional marker keep the ordinary folder appearance.

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

## Agenda panels and Calendar meetings (0.9.9)

On a tab with matching agendas, the toolbar icon opens the agenda side panel; a second click closes it. Recording starts from the panel's consent button. The keyboard shortcut keeps starting/stopping recording. Popup and panel share one recording widget. A panel opened without a toolbar invocation falls back to Chrome's sharing dialog if direct tab capture is refused. The separate agenda window remains the fallback when Chrome refuses a side panel.

The panel starts with the popup's shared recording block: idle hint, custom participant notice,
target folder and both recording buttons. Consent confirmed · Record this tab is available on ordinary
tabs too. The next Calendar meeting's Join in Meet card stays inside this block. While recording,
the block shows elapsed time, You/Others meters, folder and Stop and save; after stopping it shows
upload and saving progress, then completion. A colleague's recording adds a notice above the buttons
without hiding them.

The Agenda section below has the agenda title and planned time, or No agenda with Choose agenda
and a hint that an agenda can be attached later in Chatterbox. Choose agenda or Change agenda expands
one framed list inline. Rows show radio circles, titles and planned times, followed by No agenda.
The current choice, including No agenda, says Selected. Click a row to select and collapse the list;
Cancel restores the previous view without changing the selection. An empty window explains that no
timed agenda was found and still offers No agenda. Choosing also changes a running recording's agenda.
Up to ten unrecorded agendas planned within the previous or next 24 hours are ordered by distance
to their interval, with own agendas first on ties.

Prepare points, edit titles and drop tasks in the web app. The panel stays in one column at every
width. Away from a meeting, points and tasks are read-only. On the meeting or during capture,
discussed/task checkboxes follow existing permissions. Note reveals a growing, soft-wrapped field;
Enter finishes editing and pasted newlines become spaces. Non-empty notes show text when unfocused;
click their text to edit. HTTP(S) and www. links in points, tasks and notes open in a new tab, with
compact labels and full URLs in tooltips. Stored content stays plain text. After stopping, the panel
shows read-only discussed coverage and hides tasks. Agenda load errors and Retry stay inside the
Agenda section while recording controls keep working. The first successful edit during capture
still links an editable agenda without replacing an already selected own agenda.

New server capabilities independently enable live event updates, shared Yjs text editing, recording presence and the next Calendar meeting. The open panel owns its authenticated stream and text documents; disconnected streams retry with backoff and fall back to 15-second polling. Text inputs fetch the server seed before editing and retain focus/carets across remote changes. Older servers keep polling and plain point-note PATCHes.

A supporting server offers your next own primary-calendar Meet event in popup and panel, with Join in Meet and the connected Google account email. Joining never records. Its new tab is bound to the supplied agenda, end and validated room code; redirects between `/<code>` and `/meet/<code>` preserve that identity. Joining from the popup or panel opens the agenda on the new meeting tab; other tabs keep their own panels. Joining from a Calendar notification opens the meeting tab; click the toolbar icon to open its agenda. The binding ends when the meeting ends, the tab closes or it leaves the room. Options controls one notification per meeting and a 0/1/2/5/10-minute lead (default 0); the old agenda reminder preference is inherited. The room already being open suppresses the notification; the card is hidden on that room's tab. The badge says only now during the event when you are outside its room; REC takes priority. Background Calendar refresh is at most every five minutes, plus a page-open refresh only after 60 seconds.

The popup and panel use the application's actual FolderCombobox, bundled locally with static light/dark Tailwind CSS and recent folder IDs in extension local storage. The in-page pill keeps its existing picker.

### Room-wide agendas and sharing (0.9.9)

With `agendaRooms: 1`, a Meet room also finds visible agendas selected by another open
panel or an open/completing recording started within twelve hours. These are added to
Calendar matches, including untimed or manually selected agendas. A visible recording
choice names the colleague beneath the time. Changes refresh through agenda events
and fifteen-second room polling. A chooser opened automatically for several matches
keeps following and loads the agenda when only one match remains. A chooser opened
by the user and explicit selections retain their behavior. The toolbar opens the panel for a visible agenda,
a restricted marker or an invitation; an empty room keeps the existing popup behavior.

An inaccessible agenda shows **Agenda is not shared with you**, with no title, owner,
ID or recorder name. Recording without an agenda and choosing a different agenda remain
available. Only the agenda's author sees the share card, before and during recording.
It lists eligible people from the same server with a panel open in the same room who
cannot see that agenda, only when the agenda is tied to that meeting's Google Calendar
event. The Calendar link read through the author’s connected Google account is the
relationship the server trusts. Recording sessions, presence and other caller-declared
room codes do not qualify. Without that event and its Meet room, the list is empty
and no share card appears.
**Share** or **Share with all (n)** sends ordinary invitations;
pending rows say **Invitation sent, waiting for acceptance** and disappear after acceptance.
Co-editors cannot see the people list or send invitations from this card.

Receivers see the sharer's name, agenda title and time, **Save to** with the shared
folder chip, then **Decline** and **Accept**. The default is the recording block's target
folder. Ordinary acceptance requires an own private folder; choose one if the target
is an Organization or received folder. Existing accepted folder access keeps the web's
optional extra filing rule. Accepting shows the agenda and permits its existing co-editing;
declining grants no access. Person sharing retains the self-host Organization mode gate.

Presence is sent on panel open, selection change and every minute, only on Meet.
Closing the panel or leaving the meeting stops updates; presence expires from room
queries and people lists within about three minutes. Hourly housekeeping deletes stale rows.
Writes are serialized per user and throttled to twenty seconds, with client retries for
selection changes. Session creation sends the validated room code only with this flag;
the server stores a keyed hash, never the code. No page content or full URL is sent.
See the privacy policy twins for the disclosure. Servers without the flag retain existing
matching and receive no session room code or panel heartbeat, with no sharing UI.

### Server compatibility

Every new request requires its advertised `/api/v1/recorder/config` capability:

| Capability | Without it |
| --- | --- |
| `agendas` | Existing recording controls; no agenda requests or UI. |
| `nextMeeting` | No Calendar card, join link or now badge; existing agenda reminders remain. |
| `agendaLive` | Refresh the agenda every 15 seconds. |
| `agendaText: 1` | Existing versioned point-note PATCHes; no collaborative text requests. |
| `sessionAgenda` | No agenda field at session creation and no session agenda PATCH. Explicit completion choices still work. |
| `agendaRooms: 1` | No session room code, panel presence, room sharing cards or invitations; existing Calendar matching remains. |

Matching sends only a Meet room code and time to the server, never page content or a full tab URL. Other platforms match by time. Multiple matches offer a choice. The top-level discussed count excludes subpoints. Task checkboxes set done/open under existing canClose permissions; dropped tasks and absorbed agendas stay read-only. Servers that refuse reopening retain the saved task status and show the existing error.

An explicit agenda choice survives upload recovery and is sent on completion. No agenda sends an explicit null; a server that ignores it may still attach automatically. Unseen matches leave the server's safe automatic rules in control. An agenda folder applies only to this recording; the default folder changes only after a user folder pick. If the agenda becomes unavailable, completion saves the recording without it and explains that result.

## Load it for development

1. From the repository root run `node extensions/recorder/build.mjs`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. **Load unpacked** and select this `extensions/recorder` folder.
5. Open the extension's **Options**, grant microphone access, and pair it with
   your Chatterbox instance (see below).

The unpacked build uses a different ID from the published extension. Set
`NEXT_PUBLIC_RECORDER_EXTENSION_ID=hiipabbdnlhdkgldhkdndmohejoaecnh` when running
Chatterbox against this development build.

The build step creates gitignored `generated/` JavaScript and CSS using esbuild and the repository's Tailwind v4 toolchain. Run it again after changing shared components. `pack.mjs` builds these assets automatically; every dependency ships inside the ZIP. No remote code is loaded. Chrome loads the remaining extension JavaScript directly.
Vitest also builds these assets once before each test run when any output is missing or older than its JavaScript, CSS or build dependencies. Tests work from a fresh checkout without a manual build, including sharded runs. Build failures stop the test run.
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

This first builds the shared folder picker and text binding, then writes `dist/chatterbox-recorder-<version>.zip`. The ZIP omits the
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
