/**
 * Meeting platforms the Meeting Recorder extension can detect.
 *
 * Ids and names only. Detection rules live in the extension
 * (`extensions/recorder/lib/platforms.js`); the server needs the ids to
 * validate `RECORDER_AUTO_RECORD_PLATFORMS` and to label recordings.
 */
export const RECORDER_PLATFORMS = [
    { id: "google-meet", name: "Google Meet" },
    { id: "zoom", name: "Zoom (web)" },
    { id: "teams", name: "Microsoft Teams (web)" },
    { id: "webex", name: "Webex" },
    { id: "slack-huddle", name: "Slack huddles" },
    { id: "whereby", name: "Whereby" },
    { id: "jitsi", name: "Jitsi Meet" },
] as const;

export type RecorderPlatformId = (typeof RECORDER_PLATFORMS)[number]["id"];

export const RECORDER_PLATFORM_IDS: readonly RecorderPlatformId[] =
    RECORDER_PLATFORMS.map((platform) => platform.id);

export function isRecorderPlatformId(
    value: string,
): value is RecorderPlatformId {
    return (RECORDER_PLATFORM_IDS as readonly string[]).includes(value);
}
