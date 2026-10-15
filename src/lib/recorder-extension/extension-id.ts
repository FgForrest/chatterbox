/**
 * Chrome extension id of the Meeting Recorder, as seen from the browser.
 *
 * `NEXT_PUBLIC_*` values are inlined at build time, so this must read
 * `process.env` directly rather than go through the server env module.
 * The default is the Chrome Web Store listing's id.
 */
export const DEFAULT_RECORDER_EXTENSION_ID = "pojdfnhpfijfolehkjidbomgjemonkge";

export const RECORDER_EXTENSION_STORE_URL = `https://chromewebstore.google.com/detail/chatterbox-meeting-record/${DEFAULT_RECORDER_EXTENSION_ID}`;

export const RECORDER_EXTENSION_ID: string =
    process.env.NEXT_PUBLIC_RECORDER_EXTENSION_ID &&
    /^[a-p]{32}$/.test(process.env.NEXT_PUBLIC_RECORDER_EXTENSION_ID)
        ? process.env.NEXT_PUBLIC_RECORDER_EXTENSION_ID
        : DEFAULT_RECORDER_EXTENSION_ID;
