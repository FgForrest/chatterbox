/**
 * Chrome extension id of the Meeting Recorder, as seen from the browser.
 *
 * `NEXT_PUBLIC_*` values are inlined at build time, so this must read
 * `process.env` directly rather than go through the server env module.
 * The default is the published build's pinned id (see
 * `extensions/recorder/manifest.json` `key`).
 */
export const DEFAULT_RECORDER_EXTENSION_ID = "hiipabbdnlhdkgldhkdndmohejoaecnh";

export const RECORDER_EXTENSION_ID: string =
    process.env.NEXT_PUBLIC_RECORDER_EXTENSION_ID &&
    /^[a-p]{32}$/.test(process.env.NEXT_PUBLIC_RECORDER_EXTENSION_ID)
        ? process.env.NEXT_PUBLIC_RECORDER_EXTENSION_ID
        : DEFAULT_RECORDER_EXTENSION_ID;
