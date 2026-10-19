import { t } from "./i18n.js";
import { getSettings } from "./settings.js";

export const START_REQUEST_KEY = "recorderStartRequest";
export const START_REQUEST_TTL_MS = 15 * 60 * 1000;

/** Open a visible microphone/participant confirmation for a requested recording. */
export async function openStartRequest(input) {
    const existing = (await chrome.storage.session.get(START_REQUEST_KEY))[
        START_REQUEST_KEY
    ];
    if (
        existing?.windowId != null &&
        existing.input.tabId === input.tabId &&
        Date.now() - existing.createdAt < START_REQUEST_TTL_MS
    ) {
        const focused = await chrome.windows
            .update(existing.windowId, { focused: true })
            .catch(() => null);
        if (focused) return { pending: true };
    }
    const settings = await getSettings();
    if (!settings.dataUseAcknowledgedAt) throw new Error(t("dataUseRequired"));
    const tab = input.tabId == null ? null : await chrome.tabs.get(input.tabId).catch(() => null);
    if (input.tabId != null && !tab) throw new Error(t("meetingTabClosed"));
    const request = {
        id: crypto.randomUUID(),
        input,
        tabUrl: tab?.url,
        serverUrl: settings.serverUrl,
        createdAt: Date.now(),
    };
    await chrome.storage.session.set({ [START_REQUEST_KEY]: request });
    try {
        const window = await chrome.windows.create({
            url: chrome.runtime.getURL(
                `request/request.html?requestId=${request.id}`,
            ),
            type: "popup",
            focused: true,
            width: 500,
            height: 560,
        });
        await chrome.storage.session.set({
            [START_REQUEST_KEY]: { ...request, windowId: window.id },
        });
    } catch (error) {
        await chrome.storage.session.remove(START_REQUEST_KEY);
        throw error;
    }
    return { pending: true };
}
