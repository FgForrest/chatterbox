# Chatterbox Meeting Recorder privacy policy

Last updated: 13 October 2026

This policy describes the **Chatterbox Meeting Recorder browser extension**. It does not replace the privacy policy for a Chatterbox server or another service you choose to use.

## What the extension handles

- When you choose to record, the extension captures microphone audio and either the selected meeting tab's audio or the system audio from Chrome's screen picker. It records audio, not the screen video.
- When meeting detection is enabled, it checks browser tab URLs and audible status to identify supported meeting sites and show a recording prompt. It does not upload browsing history or tab URLs.
- It stores the server address, a write-only recorder API key, recording preferences, and recording state in browser extension storage. The key is used to authenticate uploads to your selected server.
- It buffers audio segments and session metadata in Chrome's private file system so interrupted uploads can resume. Buffered audio is removed after a successful upload or when you discard the session. If an upload fails, buffered audio can remain until you retry or discard it. The buffer and the stored key are **not encrypted by the extension at rest**; protect access to your browser profile and computer.
- By default, after a successful upload it downloads a `.webm` audio copy to your computer's Downloads folder. You can change this to ask for a save location or never download a copy in the extension's Options. A downloaded file remains until you delete it.

## Where data goes

The extension sends recording audio and session details directly to the **Chatterbox server address you authorize during pairing**, using the recorder API key. It requests recorder settings from the same server. Remote servers must use HTTPS; local development on `localhost` can use HTTP. The extension does not send recordings to a server selected by the extension publisher, and it does not use recordings for advertising, analytics, or sale.

The server operator controls the recording after receipt, including storage, retention, transcription, use of AI or storage providers, access, export, and deletion. If you operate your own server, you are responsible for its configuration and for providing a privacy notice or policy required for that server. If someone else operates it, review that operator's privacy policy before pairing. A self-hosted server may send data to other services according to its operator's configuration; this extension cannot control those transfers.

## Recording other people

You decide when to start a recording and which server receives it. Inform meeting participants and obtain any consent required by applicable law or meeting rules. The extension's participant-notice checkbox is your acknowledgement; it does not obtain consent from other participants.

## Your choices

You can stop a recording, change the destination server, revoke the recorder key on your server, change or disable local downloads, and remove the extension. Deleting a local download or browser buffer does not delete a copy already received by the server; use that server's controls or contact its operator for server-side deletion. Removing the extension removes its extension storage under normal browser behavior, but downloaded files and server copies remain.

## Policy updates and contact

We will update this policy when the extension's data handling changes and ask for renewed agreement when required. For questions about this extension, open an issue in the [Chatterbox repository](https://github.com/FgForrest/chatterbox/issues). For questions about a self-hosted server's handling of recordings, contact that server's operator.
