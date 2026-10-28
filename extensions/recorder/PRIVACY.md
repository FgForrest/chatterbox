# Chatterbox Meeting Recorder privacy policy

Last updated: 28 October 2026

This policy describes the **Chatterbox Meeting Recorder browser extension**. It does not replace the privacy policy for a Chatterbox server or another service you choose to use.

## What the extension handles

Setup asks for microphone access and briefly opens then stops a test stream. This test audio is not saved or sent. Before recording, missing access requires a decision: allow the microphone or explicitly record without it. The extension reports microphone permission status after data-use consent to the current setup site or paired server using its existing presence/pairing channel; localhost development pages can also receive this status after consent through the declared direct setup channel. Meeting prompts are enabled by default for Meet, Teams and Zoom web unless your saved choice or server settings override them. A prompt never starts recording without your action and acknowledgement of the participant notice.

- When you choose to record, the extension captures microphone audio and either the selected meeting tab's audio or the system audio from Chrome's screen picker. It records audio, not the screen video.
- When meeting detection is enabled, it checks browser tab URLs and audible status to identify supported meeting sites and show a recording prompt. It does not upload browsing history or tab URLs.
- It stores the server address, recording preferences, a random installation identifier, and recording state in browser extension storage. The installation identifier is shared after data-use consent only with the current setup site or paired server, including to retire older recorder keys from this installation; localhost development pages can also use the declared direct setup channel. It is not a device fingerprint or a secret. The recorder API token can create recordings and look up folder names to file them, and read and edit visible agendas on supporting servers, but cannot read recordings. It is encrypted before it is stored in `chrome.storage.local`. A non-exportable Web Crypto key is stored in the extension's IndexedDB. This protects against casual reading of local extension storage, but code running in the extension or someone with a copy of the whole browser profile may still use the token.
- It encrypts each five-second audio segment with a key issued by your server before writing that segment to Chrome's private file system. It sends the encrypted segments over HTTPS to your selected server. The server decrypts them for normal storage, transcription, and export. Encrypted segments remain on this device until the server confirms completion or you explicitly discard them. A browser crash or full disk can still interrupt capture; only the verified prefix may be recoverable. Browser media internals may temporarily store data outside the extension's encrypted buffer.
- It does not automatically download a playable local copy. Once the server finishes the recording, you can download one from the authenticated Chatterbox recording page. A file you download remains until you delete it.

## Optional in-meeting banner

Only after you turn on **In-meeting prompt** and grant Chrome's optional site
access, an isolated banner script runs on Google Meet (`meet.google.com`), Zoom
web (`zoom.us`), Microsoft Teams (`teams.microsoft.com`, `teams.live.com`,
`teams.cloud.microsoft`), Webex (`webex.com`) and Whereby (`whereby.com`),
including their subdomains. For these seven origins, Chrome shows the generic
warning **Read and change your data on a number of websites**, rather than a
per-site list. It displays UI only in supported meeting rooms.
It reads no page content, makes no network requests, and sends no page content
anywhere. It communicates only with this extension's
background worker for recording controls and folder selection. Folder searches
use your existing paired server; no recorder key is exposed to the meeting
page. Turning the switch off removes access to those meeting sites, unregisters
the script and hides its UI. Without this optional access, the existing system
notification remains available. Clicking the toolbar icon while the banner
notice is visible records your acknowledgement of the participant notice; it
does not obtain other participants' consent.

The meeting page can observe keystrokes typed into the pill's folder search through its capture-phase keyboard listeners.

## Meeting agendas

On servers that advertise agenda support, the extension reads visible meeting titles,
planned times, folder names, discussion points and notes, invitee and author names,
task texts, assignees and task notes from your paired server. This agenda content is
stored only in extension session storage. It caches the next 24 hours of timed agendas in extension session storage for
reminders, and displays an agenda in Chrome's side panel or a small extension window.
The side panel is enabled for a tab only after you click to open an agenda.
The reminder and banner switches are independent. Servers without support retain the
existing recording behavior and receive no agenda calls.

To match Google Meet, the background worker sends only the room code from the tab URL
and the current time to your paired server. Other platforms match by time. Calendar
meeting codes are never sent back to the browser. No page content or additional audio
is collected. The isolated banner displays server-provided agenda information and sends
only control messages to the worker; the recorder key stays outside the meeting page.
Ticking points, adding notes or points and marking tasks Done or Dropped saves those
changes to your server. Task changes affect the actual task under your existing access
rights. A selected agenda’s ID is kept with upload recovery metadata until the recording is completed or discarded; the ID is sent on completion.
Cached agendas and choices are cleared on disconnect or a new pairing. Reminder titles
may be visible in your operating system's notifications; turn reminders off in Options
to prevent them.

## Where data goes

The extension sends recording audio and session details directly to the **Chatterbox server address you authorize during pairing**, using the recorder API key. It requests recorder settings from the same server. Remote servers must use HTTPS; local development on `localhost` can use HTTP. The extension does not send recordings to a server selected by the extension publisher, and it does not use recordings for advertising, analytics, or sale.

The server operator controls the recording after receipt, including storage, retention, transcription, use of AI or storage providers, access, export, and deletion. If you operate your own server, you are responsible for its configuration and for providing a privacy notice or policy required for that server. If someone else operates it, review that operator's privacy policy before pairing. A self-hosted server may send data to other services according to its operator's configuration; this extension cannot control those transfers.

## Recording other people

You decide when to start a recording and which server receives it. Inform meeting participants and obtain any consent required by applicable law or meeting rules. Clicking **Consent confirmed · Record** acknowledges the reminder; it does not obtain consent from other participants.

## Your choices

You can stop a recording, change the destination server, revoke the recorder key on your server, discard an encrypted browser buffer, and remove the extension. A pending buffer is tied to the server and recorder account that created it; changing servers cannot make that buffer readable elsewhere. Deleting a downloaded file or browser buffer does not delete a copy already received by the server; use that server's controls or contact its operator for server-side deletion. Removing the extension removes its extension storage under normal browser behavior, but downloaded files and server copies remain.

## Policy updates and contact

We will update this policy when the extension's data handling changes and ask for renewed agreement when required. For questions about this extension, contact the publisher from whom you obtained it. For questions about a self-hosted server's handling of recordings, contact that server's operator.
