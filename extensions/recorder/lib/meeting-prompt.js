import { MEETING_PROMPT_ORIGINS, detectMeetingPlatform } from "./platforms.js";

export const MEETING_PROMPT_SCRIPT_ID = "recorder-meeting-prompt";
export const MEETING_PROMPT_DISMISSED = "meetingPromptOfferDismissed";
const FILES = ["popup/folder-combobox-shared.js", "content-meeting.js"];

/** Whether all meeting sites have the optional access used by the banner. */
export function hasMeetingPromptAccess() {
    return chrome.permissions.contains({ origins: MEETING_PROMPT_ORIGINS });
}

/** Request the meeting sites together, directly from an extension-page click. */
export function requestMeetingPromptAccess() {
    return chrome.permissions.request({ origins: MEETING_PROMPT_ORIGINS });
}

/** Return the optional meeting-site access when the switch is turned off. */
export function removeMeetingPromptAccess() {
    return chrome.permissions.remove({ origins: MEETING_PROMPT_ORIGINS });
}

/** Whether the URL belongs to one of the five banner-enabled meeting platforms. */
export function isPromptMeeting(url) {
    return (
        url?.startsWith("https://") &&
        Boolean(detectMeetingPlatform(url)?.promptOrigins)
    );
}

/** Inject only into the top frame of an already-open supported meeting site. */
export async function injectMeetingPrompt(tabId) {
    await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        files: FILES,
    });
}

let reconciliation = Promise.resolve();

/** Reconcile persistent registration and open tabs with the current optional grant. */
export function reconcileMeetingPrompt() {
    const work = reconciliation
        .catch(() => {})
        .then(async () => {
            const enabled = await hasMeetingPromptAccess();
            const scripts = await chrome.scripting.getRegisteredContentScripts({
                ids: [MEETING_PROMPT_SCRIPT_ID],
            });
            const registered = scripts.find(
                (script) => script.id === MEETING_PROMPT_SCRIPT_ID,
            );
            if (!enabled) {
                if (registered)
                    await chrome.scripting.unregisterContentScripts({
                        ids: [MEETING_PROMPT_SCRIPT_ID],
                    });
                return false;
            }
            const script = {
                id: MEETING_PROMPT_SCRIPT_ID,
                js: FILES,
                matches: MEETING_PROMPT_ORIGINS,
                allFrames: false,
                persistAcrossSessions: true,
                runAt: "document_idle",
                world: "ISOLATED",
            };
            if (registered)
                await chrome.scripting.updateContentScripts([script]);
            else await chrome.scripting.registerContentScripts([script]);
            await chrome.storage.local.set({
                [MEETING_PROMPT_DISMISSED]: true,
            });
            const tabs = await chrome.tabs.query({
                url: MEETING_PROMPT_ORIGINS,
            });
            await Promise.all(
                tabs.map((tab) => injectMeetingPrompt(tab.id).catch(() => {})),
            );
            return true;
        });
    reconciliation = work;
    return work;
}

/** Whether a permission event can change access to the meeting platforms. */
export function meetingPromptPermissionChanged(permissions) {
    return (permissions.origins ?? []).some((pattern) => {
        if (pattern === "https://*/*" || pattern === "<all_urls>") return true;
        try {
            const url = new URL(pattern.replace("*.", ""));
            return (
                url.protocol === "https:" &&
                MEETING_PROMPT_ORIGINS.some((origin) => {
                    const host = new URL(origin.replace("*.", "")).hostname;
                    return (
                        url.hostname === host ||
                        url.hostname.endsWith(`.${host}`) ||
                        host.endsWith(`.${url.hostname}`)
                    );
                })
            );
        } catch {
            return false;
        }
    });
}
