# Chrome Web Store submission text

Use the public [extension privacy policy](../PRIVACY.md) in the Store's **Privacy policy URL** field after it is published on the target branch. The policy describes the extension's own data handling; each server operator supplies the policy for its server. Verify the public link and all dashboard disclosures before submitting.

## Single purpose

Record meeting audio at the user's request and upload it to the self-hosted instance of the open-source Chatterbox server they pair with the extension.

## Prominent data disclosure

> When you record, Chatterbox Meeting Recorder captures your microphone and the meeting tab's or selected system audio. It encrypts short audio chunks before buffering them in this browser and sends them over HTTPS to the Chatterbox server you pair. That server decrypts them for storage and processing. It does not automatically download a playable copy; you can download one from your account after upload. The recorder token is encrypted in this browser. The server operator controls data after upload. You must inform participants and obtain any consent required to record them.

## Permission justifications

| Permission | Suggested dashboard explanation |
| --- | --- |
| `offscreen` | Runs Chrome's audio capture and encoder while the extension popup is closed. |
| `desktopCapture` | Opens Chrome's picker when the user records audio from a desktop meeting app or another screen. The extension keeps the selected system audio, not screen video. |
| `tabCapture` | Captures audio from the meeting tab the user chooses to record. |
| `tabs` | Reads tab URLs and audible status to recognize supported meeting sites, show the recording prompt, and stop a recording when its meeting tab closes. Tab URLs are not uploaded. |
| `notifications` | Tells the user when a meeting is detected, when recording stops, and when an upload completes or needs attention. |
| `storage` | Keeps the paired server URL, encrypted write-only recorder token, random installation identifier, preferences, and recording state on the user's device. Encrypted audio segments use Chrome's separate private file system so interrupted uploads can resume. |
| `scripting` | Installs a narrow pairing relay on the Chatterbox site the user authorizes, so that site's Setup recorder button can connect the extension. |
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
