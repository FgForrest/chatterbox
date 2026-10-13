# Chatterbox Meeting Recorder privacy policy

Last updated: 13 October 2026

This policy describes the **Chatterbox Meeting Recorder browser extension**. It does not replace the privacy policy for a Chatterbox server or another service you choose to use.

## What the extension handles

- When you choose to record, the extension captures microphone audio and either the selected meeting tab's audio or the system audio from Chrome's screen picker. It records audio, not the screen video.
- When meeting detection is enabled, it checks browser tab URLs and audible status to identify supported meeting sites and show a recording prompt. It does not upload browsing history or tab URLs.
- It stores the server address, recording preferences, a random installation identifier, and recording state in browser extension storage. The installation identifier is sent to the paired server to retire older recorder keys from this installation; it is not a device fingerprint or a secret. The write-only recorder API token is encrypted before it is stored in `chrome.storage.local`. A non-exportable Web Crypto key is stored in the extension's IndexedDB. This protects against casual reading of local extension storage, but code running in the extension or someone with a copy of the whole browser profile may still use the token.
- It encrypts each five-second audio segment with a key issued by your server before writing that segment to Chrome's private file system. It sends the encrypted segments over HTTPS to your selected server. The server decrypts them for normal storage, transcription, and export. Encrypted segments remain on this device until the server confirms completion or you explicitly discard them. A browser crash or full disk can still interrupt capture; only the verified prefix may be recoverable. Browser media internals may temporarily store data outside the extension's encrypted buffer.
- It does not automatically download a playable local copy. Once the server finishes the recording, you can download one from the authenticated Chatterbox recording page. A file you download remains until you delete it.

## Where data goes

The extension sends recording audio and session details directly to the **Chatterbox server address you authorize during pairing**, using the recorder API key. It requests recorder settings from the same server. Remote servers must use HTTPS; local development on `localhost` can use HTTP. The extension does not send recordings to a server selected by the extension publisher, and it does not use recordings for advertising, analytics, or sale.

The server operator controls the recording after receipt, including storage, retention, transcription, use of AI or storage providers, access, export, and deletion. If you operate your own server, you are responsible for its configuration and for providing a privacy notice or policy required for that server. If someone else operates it, review that operator's privacy policy before pairing. A self-hosted server may send data to other services according to its operator's configuration; this extension cannot control those transfers.

## Recording other people

You decide when to start a recording and which server receives it. Inform meeting participants and obtain any consent required by applicable law or meeting rules. Clicking **Consent confirmed · Record** acknowledges the reminder; it does not obtain consent from other participants.

## Your choices

You can stop a recording, change the destination server, revoke the recorder key on your server, discard an encrypted browser buffer, and remove the extension. A pending buffer is tied to the server and recorder account that created it; changing servers cannot make that buffer readable elsewhere. Deleting a downloaded file or browser buffer does not delete a copy already received by the server; use that server's controls or contact its operator for server-side deletion. Removing the extension removes its extension storage under normal browser behavior, but downloaded files and server copies remain.

## Policy updates and contact

We will update this policy when the extension's data handling changes and ask for renewed agreement when required. For questions about this extension, email [application_development@fg.cz](mailto:application_development@fg.cz). For questions about a self-hosted server's handling of recordings, contact that server's operator.
