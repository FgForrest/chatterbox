import { t } from "./i18n.js";
import { detectMeetingPlatform } from "./platforms.js";

/** Stable meeting identity without join-state paths, queries or passwords. */
export function meetingTarget(urlString) {
    let url;
    try {
        url = new URL(urlString);
    } catch {
        return null;
    }
    const platform = detectMeetingPlatform(urlString);
    let meetingId = null;
    if (platform?.id === "google-meet") meetingId = url.pathname.split("/")[1];
    else if (platform?.id === "zoom")
        meetingId = url.pathname.match(/^\/wc\/(\d+)/)?.[1];
    else if (platform?.id === "teams") {
        meetingId = `${url.pathname}${url.hash}`.match(
            /\/(?:meetup-join|l\/meet|meet|call)\/([^/?#]+)/i,
        )?.[1];
        if (meetingId) {
            try {
                meetingId = decodeURIComponent(meetingId);
            } catch {
                meetingId = null;
            }
        }
    } else if (platform) meetingId = `${url.host}${url.pathname}`;
    return { origin: url.origin, platformId: platform?.id ?? null, meetingId };
}

/** Compare URLs or stored meeting identities, using origin for an ordinary tab. */
export function sameMeetingTarget(before, after) {
    const first = typeof before === "string" ? meetingTarget(before) : before;
    const second = typeof after === "string" ? meetingTarget(after) : after;
    if (!first || !second || first.platformId !== second.platformId) return false;
    if (!first.platformId) return first.origin === second.origin;
    return Boolean(first.meetingId && first.meetingId === second.meetingId);
}

/** Safe visible meeting label; never includes query parameters or fragments. */
export function meetingLabel(urlString) {
    const target = meetingTarget(urlString);
    if (!target) return "";
    const platform = detectMeetingPlatform(urlString);
    const id = ["google-meet", "teams", "zoom"].includes(target.platformId)
        ? target.meetingId : null;
    return `${platform?.name ?? t("recording")} · ${new URL(target.origin).host}${id ? ` · ${id}` : ""}`;
}
