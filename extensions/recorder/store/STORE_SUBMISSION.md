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
| `alarms` | Schedules optional Calendar reminders with the user’s chosen lead time (legacy agenda reminders on older servers) and refreshes server recording preferences, retries interrupted uploads, polls completion, and stops a one-click recording after the configured quiet period. |
| Optional `https://*/*` host access | Allows pairing and uploads to the Chatterbox HTTPS server origin chosen by the user. Separately, when the user turns on In-meeting prompt, requests Google Meet, Zoom web, Microsoft Teams, Webex and Whereby together to show recording instructions and controls inside supported meetings. The isolated banner reads no page content, makes no network requests and sends no page content anywhere. Turning the switch off removes that meeting-site access. Version 0.8.0 adds only the required sidePanel permission. |
| Optional `http://localhost/*` host access | Allows pairing a Chatterbox instance on the user's own computer for local development. Remote HTTP is not supported. |
| `externally_connectable` for `localhost` | Allows a local Chatterbox page to message the extension for setup without a pairing relay. Other origins use the relay after the user grants access. |

## Data-use declarations to check in the dashboard

Declare recording audio, authentication information (the recorder key), the random installation identifier, website/tab information used for meeting detection, meeting agenda titles, points and notes, invitee and author names, task texts, assignees, task notes and edits (agenda content cached only in session storage), and user settings as applicable to the current Store form. State that recordings go to the user-selected server, not to the extension publisher by default. Declare no advertising use or sale only while the implementation continues to match those statements. If the publisher also operates a selectable server, disclose that service and its separate privacy policy accurately.

The privacy policy, store listing, permission explanations, and in-extension consent text must describe the same behavior. Approval remains the Chrome Web Store reviewer's decision.

## Remaining submission risks

- The recorder token is encrypted under a non-exportable Web Crypto key in extension IndexedDB, and the OPFS recovery chunks are encrypted under a server-issued per-capture key. These measures do not protect against malicious code running in the extension or every browser-profile compromise. Describe that boundary accurately in the dashboard.
- The Store assigns the extension ID when the ZIP is uploaded. If it differs from the unpacked development ID, set `NEXT_PUBLIC_RECORDER_EXTENSION_ID` for the Chatterbox web app before using site-based pairing.
- Verify the consent, pairing, microphone, manual recording, one-click recording, failed-upload recovery, and authenticated web-download flows in Chrome before submission. Automated tests do not exercise Chrome's permission dialogs or the screen picker.

## What changed in 0.9.8

- Includes the 0.9.7 changes below; its ZIP was not uploaded to the Store. Use the 0.9.8 package instead.
- Supporting servers mark accessible restricted Organization folders with an olive folder-lock icon in the
  target chips and folder choosers in the popup, agenda panel (or fallback window), recorder window,
  full-page picker and in-page recording pill, after folder results load.
  Inaccessible folders are absent from recorder results. If a saved target
  becomes unavailable, the chooser explains that it must be selected again or left unfiled.
- Older server responses without the optional restricted marker keep the ordinary folder appearance.
  No new request parameter, permission or data collection.

## What changed in 0.9.7

- Agenda points, tasks and their notes show clickable HTTP(S) and www. links with compact labels
  and full-URL tooltips. Links open in a new tab from the side panel and fallback window.
- Notes expand with soft-wrapped text while editing, keep Enter to finish, and replace pasted
  newlines with spaces. Unfocused notes show linked text; clicking outside a link edits the note.
  Stored agenda content remains plain text, with the existing collaborative and legacy save paths.
- Stopped recordings finish uploading even when Stop arrives as the last upload finishes. The worker,
  popup, recorder window and browser startup recover a stalled completion automatically.
- Server requests time out instead of holding an upload forever. Chunk uploads retry with backoff;
  completion failures keep the encrypted buffer and offer Retry upload.
- Each pending encrypted recording in Options now offers Retry upload beside Discard, with English
  and Czech explanations when another capture is active, access is refused or the recording key expired.
- Recognizes Meet rooms at both /<code> and /meet/<code>, including account-scoped redirects.
- Join in Meet binds the new tab to its agenda instead of matching it again. Popup and panel Join
  open its per-tab agenda panel while other tabs keep their own panels. Calendar notification Join
  opens and binds the meeting tab; the toolbar icon opens its agenda. Bindings expire at meeting end,
  tab close or navigation out of the room.
- The panel is a single-column meeting checklist: discussed points, done checkboxes, notes behind
  Note, recording meters and a read-only upload summary. Preparation, point titles and dropping tasks
  stay in the web app. One Change agenda link replaces the attachment and navigation controls.
- Popup and panel hide the default consent sentence, retaining operator/user notices. Next meeting
  is hidden on its room and during capture/upload. Failed agenda loads show Retry rather than no agendas.
- Stable agenda links redirect relatively behind reverse proxies. Existing recorder routes remain;
  task reopening adds open to the existing status field. A released server that refuses it keeps the
  saved status and shows an error. No new endpoint, response field or manifest permission.
- Join bindings cache only the tab ID, agenda ID, end and validated room code with pairing identity in
  session storage. Both privacy policies describe this lifetime; no new external data recipient.
- Includes the Czech Dropped/Zahozeno wording from 0.9.6, which was never uploaded.

## What changed in 0.9.6

- Czech only: the agenda's task action Drop reads Zahodit and a dropped task Zahozeno, as in the web
  application, instead of Zrušit and Zrušeno. Zrušit stays reserved for Cancel. The Czech privacy policy
  uses the same word.
- No permission, data-use or server-contract change against 0.9.5.

## What changed in 0.9.5

- Another agenda in the side panel and fallback window adds relevant unrecorded agendas planned within
  the previous or next 24 hours, before and during recording. Up to ten choices are ordered by distance
  to their planned interval, with own agendas first on ties. English and Czech rows show planned times.
- Automatic popup, banner and notification matching keeps its existing time window. Either agenda lookup
  can fail without hiding results from the other. Uses existing agenda endpoints on released servers;
  no new capability, permission or data-use change.

## What changed in 0.9.4

- Target folders use the web application's folder chip in the popup, agenda panel, recorder window and in-page
  recording bar. The chip shows the folder name with its full path as a tooltip. Organization folders use the blue
  Organization icon; private folders use the red folder icon. A folder remembered by an earlier version shows the
  private look until the folder list refreshes.
- Clicking the chip opens the existing chooser. Remove sets File later; an unfiled target shows Add to folder.
  Older servers keep the start folder read-only with the existing explanation.
- The recorder window grows while its folder list is open and shrinks after it closes. Chrome's source picker
  keeps its initial 800 × 680 size.
- Stop in the popup, agenda panel and recorder window works after the server refused a folder change during the
  recording (since 0.9.0 it did nothing until the next successful change).
- No permission, data-use or server-contract change against 0.9.3. Folder scope is remembered locally alongside
  the existing folder setting and recovery state; it is not sent to the server. The privacy policies already
  describe recording preferences and state, so no policy update is needed.

## What changed in 0.9.3

- The popup grows to its full height while the folder list is open, so the list is no longer squeezed into the
  space left below the field. The list also stays inside the popup instead of being clipped at its edge.
- A folder list left open closes when the popup or agenda panel switches views, for example when the recording
  stops, instead of staying over the next view.
- No permission, data-use or server-contract change against 0.9.2.

## What changed in 0.9.2

- Clearing an agenda point's title no longer sends an empty text; leaving the field restores the saved title.
  Refused saves stop retrying; network and server errors retry with backoff.
- The toolbar icon still closes an open agenda panel after Chrome restarts the extension's service worker.
- Ticking or editing an agenda in a panel on a tab that is not being recorded no longer selects that agenda for the
  running recording; the explicit switch and unlink actions still work from any panel.
- No permission, data-use or server-contract change against 0.9.1.

## What changed in 0.9.1

- Options show the meeting notification switch and lead time whenever agenda reminders or the Calendar
  notification can fire, also on servers without the Calendar capability. One switch governs both; the default lead
  stays 0 (at meeting start).
- The agenda panel's other-agenda and close buttons have their own labels in English and Czech.
- No permission, data-use or server-contract change against 0.9.0.

## What changed in 0.9.0

- The icon toggles an agenda panel on matching tabs, including while recording. Popup and panel share recording controls. Non-agenda tabs and the keyboard shortcut retain their existing behavior. Chrome refusals keep the fallback window and sharing dialog.
- On servers advertising the relevant capability: live agenda invalidations, collaborative text, recording attribution, and scoped Calendar Meet joins using the connected account email. No new permissions, host access, web-accessible resources or remote code.
- Calendar data received: own event title, start/end, validated join link and connected Google account email, cached in extension session storage. One optional notification per meeting replaces the agenda reminder, with configurable lead time and suppression when its room is open. Join never records.
- Popup and panel bundle the real application folder chooser and static light/dark CSS. Recent folder IDs remain local. The in-page picker is unchanged.
- Update the dashboard's Calendar data declarations and privacy-policy links. Verify the real toolbar gesture, native capture permission, side-panel toggle and notification buttons before Store submission. Packaging does not submit a release.

## What changed in 0.8.3

- Agenda progress counts only top-level points; subpoints do not affect the
  "X of Y discussed" count.
- No permission changes. The server contract is unchanged, and older servers
  keep working.

## What changed in 0.8.2

- Keeps the fallback window's matched agenda when the requesting tab closes
  while matching. Per-tab panel contexts are still removed when their tab closes.
- No permission changes. The server contract is unchanged, and older servers
  keep working.

## What changed in 0.8.1

- No permission changes. The side panel is enabled per tab only after a click,
  immediately before opening. It has no global default path and is absent from
  the menu on tabs where no agenda has been opened. Chrome refusals still open
  the same packaged page in a small extension window.
- While recording, the popup shows an agenda card only for a selected agenda or
  matching agendas. Without a selection, one button opens the picker.
- Options hides the agenda section on servers without agenda support.
- English and Czech agenda lists consistently say agendas; events and meeting
  calls remain separate terms. The 0.8.0 server contract is unchanged, and older
  servers keep working.

## What changed in 0.8.0

- Adds only `sidePanel` to required manifest permissions. No extra host access,
  web-accessible resources or remote code. Agendas open from an explicit click.
- Reads agendas from the paired server only after `features.agendas: true`.
  Released servers without this flag keep 0.7.0 recording behavior.
- The side panel supports preparation and live review: discussed ticks, notes,
  quick points and actual task Done/Drop actions with existing permissions.
- Reminder alarms load the next 24 hours every 30 minutes and when the popup opens, and notify
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
