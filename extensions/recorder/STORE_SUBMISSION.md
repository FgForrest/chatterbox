# Chrome Web Store submission text

Use the public [extension privacy policy](PRIVACY.md) in the Store's **Privacy policy URL** field after it is published on the target branch. The policy describes the extension's own data handling; each server operator supplies the policy for its server. Verify the public link and all dashboard disclosures before submitting.

## Single purpose

Record meeting audio at the user's request and send it to the Chatterbox server the user pairs with the extension.

## Prominent data disclosure

> When you record, Chatterbox Meeting Recorder captures your microphone and the meeting tab's or selected system audio. It buffers audio in this browser while uploading it to the Chatterbox server you pair. A local audio copy is downloaded by default; you can turn that off in Options. The recorder key is stored in this browser. The server operator controls data after upload. You must inform participants and obtain any consent required to record them.

## Permission justifications

| Permission | Suggested dashboard explanation |
| --- | --- |
| `offscreen` | Runs Chrome's audio capture and encoder while the extension popup is closed. |
| `desktopCapture` | Opens Chrome's picker when the user records audio from a desktop meeting app or another screen. The extension keeps the selected system audio, not screen video. |
| `tabCapture` | Captures audio from the meeting tab the user chooses to record. |
| `tabs` | Reads tab URLs and audible status to recognize supported meeting sites, show the recording prompt, and stop a recording when its meeting tab closes. Tab URLs are not uploaded. |
| `notifications` | Tells the user when a meeting is detected, when recording stops, and when an upload completes or needs attention. |
| `downloads` | Saves a local `.webm` copy after upload when the user's local-copy setting allows it. The default is to download a copy; the user can disable this in Options. |
| `storage` | Keeps the paired server URL, write-only recorder key, preferences, and recording state on the user's device. Audio segments use Chrome's separate private file system so interrupted uploads can resume. |
| `scripting` | Installs a narrow pairing relay on the Chatterbox site the user authorizes, so that site's Setup recorder button can connect the extension. |
| `alarms` | Refreshes server recording preferences and stops a one-click recording after the configured quiet period. |
| Required `https://riffado.com/*` and `https://*.riffado.com/*` host access | Allows the existing Chatterbox-compatible web app and its subdomains to detect the extension and offer pairing. Review whether this access can be made optional before store submission. |
| Optional `https://*/*` host access | Allows the user to pair a self-hosted Chatterbox server at a chosen HTTPS origin. Access is requested for that specific origin during pairing. |
| Optional `http://localhost/*` host access | Allows pairing a Chatterbox instance on the user's own computer for local development. Remote HTTP is not supported. |

## Data-use declarations to check in the dashboard

Declare recording audio, authentication information (the recorder key), website/tab information used for meeting detection, and user settings as applicable to the current Store form. State that recordings go to the user-selected server, not to the extension publisher by default. Declare no advertising use or sale only while the implementation continues to match those statements. If the publisher also operates a selectable server, disclose that service and its separate privacy policy accurately.

The privacy policy, store listing, permission explanations, and in-extension consent text must describe the same behavior. Approval remains the Chrome Web Store reviewer's decision.
