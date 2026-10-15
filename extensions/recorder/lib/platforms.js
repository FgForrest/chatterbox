// Meeting platform registry.
//
// One entry per supported web meeting platform. `inMeeting(url)` answers
// "is this tab inside an actual meeting room", not merely "on the platform":
// Meet's landing page and Zoom's marketing pages must not arm the recorder.
// Keep this table in step with the server copy in
// src/lib/recorder/platforms.ts (ids and names only there).

/**
 * @typedef {Object} Platform
 * @property {string} id            stable id, also the server's `platformHint`
 * @property {string} name          user-facing label
 * @property {(url: URL) => boolean} inMeeting
 */

function hostIs(url, host) {
    return url.hostname === host || url.hostname.endsWith(`.${host}`);
}

/** @type {Platform[]} */
export const PLATFORMS = [
    {
        id: "google-meet",
        name: "Google Meet",
        // Rooms are three lowercase groups: xxx-xxxx-xxx. Everything else on
        // the host (landing, /new redirects, settings) is not a meeting.
        inMeeting: (url) =>
            hostIs(url, "meet.google.com") &&
            /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}(\/|$)/.test(url.pathname),
    },
    {
        id: "zoom",
        name: "Zoom (web)",
        // Web client rooms live under /wc/<meetingId>/... on any zoom.us host.
        inMeeting: (url) =>
            hostIs(url, "zoom.us") && /^\/wc\/\d+/.test(url.pathname),
    },
    {
        id: "teams",
        name: "Microsoft Teams (web)",
        // Teams URLs are volatile; treat a meetup/call path on any Teams host
        // as a meeting and let real-world testing tighten this.
        inMeeting: (url) =>
            (hostIs(url, "teams.microsoft.com") ||
                hostIs(url, "teams.live.com") ||
                hostIs(url, "teams.cloud.microsoft")) &&
            /meetup-join|\/l\/meet|\/meet\/|\/call\//i.test(
                `${url.pathname}${url.hash}`,
            ),
    },
    {
        id: "webex",
        name: "Webex",
        inMeeting: (url) =>
            hostIs(url, "webex.com") &&
            /^\/(meet|wbxmjs|webappng)\//.test(url.pathname),
    },
    {
        id: "slack-huddle",
        name: "Slack huddles",
        inMeeting: (url) =>
            hostIs(url, "app.slack.com") && url.pathname.startsWith("/huddle/"),
    },
    {
        id: "whereby",
        name: "Whereby",
        inMeeting: (url) =>
            hostIs(url, "whereby.com") &&
            /^\/[^/]+\/?$/.test(url.pathname) &&
            url.pathname !== "/",
    },
    {
        id: "jitsi",
        name: "Jitsi Meet",
        inMeeting: (url) =>
            hostIs(url, "meet.jit.si") &&
            /^\/[^/]+\/?$/.test(url.pathname) &&
            url.pathname !== "/",
    },
];

export const PLATFORM_IDS = PLATFORMS.map((platform) => platform.id);

/** The platform whose meeting room this URL is inside, or null. */
export function detectMeetingPlatform(urlString) {
    let url;
    try {
        url = new URL(urlString);
    } catch {
        return null;
    }
    for (const platform of PLATFORMS) {
        try {
            if (platform.inMeeting(url)) return platform;
        } catch {
            // a malformed rule must not break detection for the rest
        }
    }
    return null;
}

export function platformById(id) {
    return PLATFORMS.find((platform) => platform.id === id) ?? null;
}
