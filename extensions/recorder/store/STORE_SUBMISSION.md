# Chrome Web Store submission text

Use the public [extension privacy policy](../PRIVACY.md) in the Store's **Privacy policy URL** field after it is published on the target branch. The policy describes the extension's own data handling; each server operator supplies the policy for its server. Verify the public link and all dashboard disclosures before submitting.

## Single purpose

Record meeting audio at the user's request and upload it to the self-hosted instance of the open-source Chatterbox server they pair with the extension.

## Prominent data disclosure

> When you record, Chatterbox Meeting Recorder captures your microphone and the meeting tab's or selected system audio. It encrypts short audio chunks before buffering them in this browser and sends them over HTTPS to the Chatterbox server you pair. That server decrypts them for storage and processing. It does not automatically download a playable copy; you can download one from your account after upload. The recorder token is encrypted in this browser. The server operator controls data after upload. You must inform participants and obtain any consent required to record them.

## In-extension consent and setup

Before connecting or recording, Options shows three points:

- When recording, the extension captures your microphone and meeting audio.
- It encrypts audio in your browser and sends it only to the Chatterbox server
  you connect for storage and processing (transcripts and summaries). That
  server's operator controls it there.
- You must inform participants about recording and obtain any required consent.

**Full notice and privacy policy** expands the existing full disclosure and
privacy-policy link. **I understand and agree** saves the consent timestamp;
there is no checkbox. The next step separately offers microphone permission,
with a persistent-option example and a saved **Not now** choice. The third step
separately requests access to the chosen server. One click never triggers both
browser permission dialogs. Other settings appear after setup. The ready screen offers the optional
**In-meeting prompt** switch; setup remains three steps. Enabling it separately
requests the five meeting platforms (seven origins) in one Chrome permission
prompt. Chrome shows the generic warning **Read and change your data on a
number of websites** (Czech: **Čtení a úprava dat na různých webech**), rather
than a per-site list.

The address comes from the toolbar's current tab, a marked open recorder setup
tab (`?section=recorder`), or a typed HTTPS address. With several marked tabs,
the user chooses a host and title. Typed addresses open the server's recorder
settings in a new tab. During the 15-minute setup flow, only a key from the
chosen tab and origin, with a current site grant, is accepted automatically.
Other proposals still require confirmation. Older servers keep their Connect
button; after five seconds the extension offers to focus the tab and explains
how to finish there. Manual address-and-key pairing stays available.

## Permission justifications

| Permission | Suggested dashboard explanation |
| --- | --- |
| `offscreen` | Runs Chrome's audio capture and encoder while the extension popup is closed. |
| `desktopCapture` | Opens Chrome's picker when the user records audio from a desktop meeting app or another screen. The extension keeps the selected system audio, not screen video. |
| `tabCapture` | Captures audio from the current tab when the user clicks Record this tab. |
| `tabs` | Reads tab URLs and audible status to recognize supported meeting sites, show the recording prompt, and stop a recording when its meeting tab closes. Finds marked recorder setup tabs and shows their host and title for the user's connection choice. Tab URLs and titles are not uploaded. With agenda support, only the Meet room code from the URL and current time go to the paired server for matching. |
| `notifications` | Tells the user when a meeting is detected, when recording stops, and when an upload completes or needs attention. |
| `storage` | Keeps the paired server URL, encrypted recorder token (creates recordings and looks up folder names for filing, and reads and edits visible agendas on supporting servers, but cannot read recordings), random installation identifier, preferences, and recording state on the user's device. Encrypted audio segments use Chrome's separate private file system so interrupted uploads can resume. |
| `scripting` | Installs a narrow pairing relay on the Chatterbox site the user authorizes. After the user turns on In-meeting prompt and grants meeting-site access, registers and injects a top-frame isolated recording banner on supported meeting sites. The banner reads no page content and makes no network requests. |
| `sidePanel` | Shows the user-selected meeting agenda alongside browser tabs, with discussion ticks, notes and task review while recording. Opened only by a user click; if Chrome refuses, the same packaged page opens in a small extension window. |
| `alarms` | Schedules agenda reminders one minute before timed meetings and refreshes server recording preferences, retries interrupted uploads, polls completion, and stops a one-click recording after the configured quiet period. |
| Optional `https://*/*` host access | Allows pairing and uploads to the Chatterbox HTTPS server origin chosen by the user. Separately, when the user turns on In-meeting prompt, requests Google Meet, Zoom web, Microsoft Teams, Webex and Whereby together to show recording instructions and controls inside supported meetings. The isolated banner reads no page content, makes no network requests and sends no page content anywhere. Turning the switch off removes that meeting-site access. Version 0.8.0 adds only the required sidePanel permission. |
| Optional `http://localhost/*` host access | Allows pairing a Chatterbox instance on the user's own computer for local development. Remote HTTP is not supported. |
| `externally_connectable` for `localhost` | Allows a local Chatterbox page to message the extension for setup without a pairing relay. Other origins use the relay after the user grants access. |

## Data-use declarations to check in the dashboard

Declare recording audio, authentication information (the recorder key), the random installation identifier, website/tab information used for meeting detection, meeting agenda content and edits, and user settings as applicable to the current Store form. State that recordings go to the user-selected server, not to the extension publisher by default. Declare no advertising use or sale only while the implementation continues to match those statements. If the publisher also operates a selectable server, disclose that service and its separate privacy policy accurately.

The privacy policy, store listing, permission explanations, and in-extension consent text must describe the same behavior. Approval remains the Chrome Web Store reviewer's decision.

## Remaining submission risks

- The recorder token is encrypted under a non-exportable Web Crypto key in extension IndexedDB, and the OPFS recovery chunks are encrypted under a server-issued per-capture key. These measures do not protect against malicious code running in the extension or every browser-profile compromise. Describe that boundary accurately in the dashboard.
- The Store assigns the extension ID when the ZIP is uploaded. If it differs from the unpacked development ID, set `NEXT_PUBLIC_RECORDER_EXTENSION_ID` for the Chatterbox web app before using site-based pairing.
- Verify the consent, pairing, microphone, manual recording, one-click recording, failed-upload recovery, and authenticated web-download flows in Chrome before submission. Automated tests do not exercise Chrome's permission dialogs or the screen picker.

## What changed in 0.8.0

- Adds only `sidePanel` to required manifest permissions. No extra host access,
  web-accessible resources or remote code. Agendas open from an explicit click.
- Reads agendas from the paired server only after `features.agendas: true`.
  Released servers without this flag keep 0.7.0 recording behavior.
- The side panel supports preparation and live review: discussed ticks, notes,
  quick points and actual task Done/Drop actions with existing permissions.
- Reminder alarms load the next 24 hours with configuration refresh and notify
  one minute before timed agendas. Options can disable reminders or the banner
  agenda independently. No agenda means no agenda reminder.
- The meeting banner and pill offer Agenda. Matching sends only a tab's Meet
  room code and time to the paired server, never page content or a full URL.
- The popup preselects the agenda's folder and supports choosing another agenda
  or none during capture. The selected ID survives upload recovery.

### Dashboard update for 0.8.0

Use the `sidePanel` justification above and update `alarms`, `tabs`, `storage`
and data-use declarations for agenda content and edits. Update both privacy URLs.
Check real Chrome notification gestures, fallback window, popup/banner clicks,
light/dark and narrow panel appearance, task permissions, unsupported-server
behavior and reminder opt-out before uploading. No Store upload is performed by
packaging the ZIP.

## What changed in 0.7.0

- Optional **In-meeting prompt** replaces system meeting notifications with a
  banner in Google Meet, Zoom web, Teams, Webex and Whereby. It reads no page
  content. Its instructions reflect whether the extension icon is pinned and
  show the actual assigned shortcut.
- While the notice is visible, the toolbar icon or shortcut records the meeting
  tab directly. **Share through Chrome’s dialog** keeps the existing picker.
- The in-page recording pill shows elapsed time and target folder, supports the
  same searchable folder changes as the popup, and offers Stop. Older servers
  keep the start folder read-only. No server update is needed.
- A one-time popup offer, Options switch and setup-ready switch request optional
  access only after a user click. Turning it off removes that access. Updates
  open no announcement tab. Existing system notifications remain the fallback;
  their body opens the new Options switch only when meeting-site access is
  missing. If access exists but the banner cannot mount, the plain notification
  focuses the meeting tab.
- No new manifest permissions, no additional web-accessible resources and no
  remote code. The banner and shared folder control are packaged locally.

### Dashboard update for 0.7.0

Replace the `scripting` and optional `https://*/*` explanations with the exact
text in the table above. Review the updated English and Czech privacy policies
at their existing URLs after publication. Keep the existing data-use disclosures;
the banner adds no collection of page content.

Take a new English and Czech Store screenshot of the in-meeting banner in a
supported meeting, using invented participant names only. Also capture the
recording pill with timer, editable folder and Stop. Verify pinned and unpinned
instructions, light/dark appearance and a narrow window in Chrome before
submission. Existing 0.6.0 screenshots do not show the new banner.

## What changed in 0.6.0

- The popup's primary button records the current tab directly, including tabs without a detected meeting. A separate **Record another screen or app** button opens Chrome's picker. Unsupported tabs fall back to that picker.
- **Target folder in Chatterbox** is available before and during recording in the popup and recorder window. The target survives browser restarts and is remembered for the next recording. Older servers show the start folder read-only; if a changed folder is refused when saving, completion retries with the start folder.
- Includes English and Czech copy for the new controls. No new permissions.

- Chrome's "Choose what to share" dialog shows its list of tabs and screens again. On macOS and Linux Chrome draws that dialog inside the recorder window, which 0.4.1 shrank to its own content before the dialog opened, so only Cancel and a disabled Share were left. The window now opens at 800 x 680, centered over the browser window, and narrows to the recorder only after a source is chosen.

## What changed in 0.5.0

- Setup is three sequential steps: data-use consent, microphone, then server access and pairing. Consent uses three points, an expandable full notice and one agreement button without a checkbox.
- Microphone guidance names Chrome's persistent choice, uses neutral wording for Edge and Brave, saves a skipped state and explains browser, OS and managed-policy blocks.
- Setup finds marked open recorder tabs or accepts a typed address. Matching setup keys connect automatically; foreign proposals retain confirmation. Older servers fall back to their Connect button. Other settings appear once setup is complete.
- Includes 0.4.1's recorder and microphone window fitting below.

## What changed in 0.4.1

- The recorder window is as tall as what it shows: picking a source, recording, saving and done no longer leave an empty area below the content, also when Chrome's sharing bar appears or goes away. The microphone window fits the same way.

## What changed in 0.4.0

- The popup's folder picker is a search field: type part of a folder path to find it among hundreds of folders. The last folder used stays offered.
- The extension asks the server for matching folders only (`GET /api/v1/recorder/folders?q=`, at most 20) and for the remembered folder (`?id=`), instead of downloading every folder path. Both list only folders the user can file a recording into.
- The recorder key is described accurately: it creates recordings and looks up folder names to file them; it cannot read recordings.

## What changed in 0.3.1

- The meeting notification's Record button reads Consent confirmed · Record and carries the participant notice; it no longer opens a separate window with a consent checkbox. Chrome does not let a notification capture a tab, so it opens Chrome's sharing dialog directly (or, when the microphone is not allowed yet, a small microphone window first). Clicking the toolbar icon still records the meeting tab directly.
- The microphone window uses the recorder's own compact layout; its record buttons carry the consent wording when no consent was given before.
- The recorder window warns when the shared source stays silent for 20 seconds, which means a window, the screen or the wrong tab was shared without the meeting audio.

## What changed in 0.3.0

- Self-hosted setup continues from data-use consent to access for the selected server and a microphone prompt. Return to the original dashboard tab, click Connect, then explicitly confirm the server in the same setup tab.
- Site access granted through Chrome activates pairing only for the current setup or paired server origin. Wildcard grants and unrelated sites never install a relay. Manual connection no longer needs a page reload.
- Meet, Teams and Zoom web now default to Prompt, including existing installations with no saved platform choice. The previous implicit Off default changes to Prompt on these three platforms. Other platforms stay Off unless chosen by the user or server. Saved choices and server recording defaults keep precedence.
- Meeting notifications offer Record and Not now. Record opens the participant notice, microphone check and Chrome audio picker. Select the meeting tab and enable Share tab audio.
- Missing microphone permission shows a toolbar warning and pauses starts until you allow access or explicitly choose recording without your microphone. Blocked access shows Chrome instructions.
- The web setup page can read microphone permission status. No new extension permissions or broader external messaging origins.
