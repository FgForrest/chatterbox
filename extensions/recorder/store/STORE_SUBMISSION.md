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
browser permission dialogs. Other settings appear after setup.

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
| `tabCapture` | Captures audio from the meeting tab the user chooses to record. |
| `tabs` | Reads tab URLs and audible status to recognize supported meeting sites, show the recording prompt, and stop a recording when its meeting tab closes. Finds marked recorder setup tabs and shows their host and title for the user's connection choice. Tab URLs and titles are not uploaded. |
| `notifications` | Tells the user when a meeting is detected, when recording stops, and when an upload completes or needs attention. |
| `storage` | Keeps the paired server URL, encrypted recorder token (creates recordings and looks up folder names for filing, but cannot read recordings), random installation identifier, preferences, and recording state on the user's device. Encrypted audio segments use Chrome's separate private file system so interrupted uploads can resume. |
| `scripting` | Installs a narrow pairing relay on the Chatterbox site the user authorizes, so the selected setup tab can send a recorder key automatically, or the user can click Connect on older servers. |
| `alarms` | Refreshes server recording preferences, retries interrupted uploads, polls completion, and stops a one-click recording after the configured quiet period. |
| Optional `https://*/*` host access | Allows the user to pair a self-hosted Chatterbox server at a chosen HTTPS origin. Access is requested for that specific origin during pairing. |
| Optional `http://localhost/*` host access | Allows pairing a Chatterbox instance on the user's own computer for local development. Remote HTTP is not supported. |
| `externally_connectable` for `localhost` | Allows a local Chatterbox page to message the extension for setup without a pairing relay. Other origins use the relay after the user grants access. |

## Data-use declarations to check in the dashboard

Declare recording audio, authentication information (the recorder key), the random installation identifier, website/tab information used for meeting detection, and user settings as applicable to the current Store form. State that recordings go to the user-selected server, not to the extension publisher by default. Declare no advertising use or sale only while the implementation continues to match those statements. If the publisher also operates a selectable server, disclose that service and its separate privacy policy accurately.

The privacy policy, store listing, permission explanations, and in-extension consent text must describe the same behavior. Approval remains the Chrome Web Store reviewer's decision.

## Remaining submission risks

- The recorder token is encrypted under a non-exportable Web Crypto key in extension IndexedDB, and the OPFS recovery chunks are encrypted under a server-issued per-capture key. These measures do not protect against malicious code running in the extension or every browser-profile compromise. Describe that boundary accurately in the dashboard.
- The Store assigns the extension ID when the ZIP is uploaded. If it differs from the unpacked development ID, set `NEXT_PUBLIC_RECORDER_EXTENSION_ID` for the Chatterbox web app before using site-based pairing.
- Verify the consent, pairing, microphone, manual recording, one-click recording, failed-upload recovery, and authenticated web-download flows in Chrome before submission. Automated tests do not exercise Chrome's permission dialogs or the screen picker.

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
