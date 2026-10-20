import { t } from "./i18n.js";
import { connectOrigin, grantHostAccess, originOf } from "./pairing.js";
import { SETUP_FLOW_KEY } from "./pairing-request.js";

/** Recorder settings and onboarding advertise `?section=recorder` while visible. */
export const RECORDER_SETUP_SECTION = "recorder";

/** Normalize a typed address to HTTPS; retain HTTP only for local development. */
export function normalizeSetupAddress(value) {
    const text = String(value).trim();
    if (!text || /[\s\\*]/.test(text)) return null;
    try {
        const url = new URL(text.includes("://") ? text : `https://${text}`);
        if (url.username || url.password || !url.hostname) return null;
        if (
            url.protocol !== "https:" &&
            !(url.protocol === "http:" && url.hostname === "localhost")
        )
            return null;
        return url.origin;
    } catch {
        return null;
    }
}

/** Find marked recorder setup tabs, including onboarding, without host access. */
export function findRecorderSetupTabs(tabs) {
    return tabs.flatMap((tab) => {
        try {
            const url = new URL(tab.url);
            if (
                !Number.isInteger(tab.id) ||
                url.searchParams.get("section") !== RECORDER_SETUP_SECTION ||
                normalizeSetupAddress(tab.url) !== url.origin
            )
                return [];
            return [
                {
                    origin: url.origin,
                    tabId: tab.id,
                    title: tab.title || url.host,
                },
            ];
        } catch {
            return [];
        }
    });
}

/** Continue a toolbar setup, requesting site access on the caller's gesture. */
export async function prepareOriginSetup({
    origin,
    tabId = null,
    typed = false,
}) {
    if (normalizeSetupAddress(origin) !== origin)
        throw new Error(t("invalidConnection"));
    const access = grantHostAccess(origin);
    if (!(await access)) throw new Error(t("serverAccessDenied"));
    if (typed) {
        const created = await chrome.tabs.create({
            url: `${origin}/settings?section=recorder`,
            active: false,
        });
        tabId = created.id;
    }
    const tab = await chrome.tabs.get(tabId);
    if (originOf(tab.pendingUrl || tab.url) !== origin)
        throw new Error(t("pairingOriginMismatch"));
    const surface = await chrome.tabs.getCurrent();
    await chrome.storage.session.set({
        [SETUP_FLOW_KEY]: {
            origin,
            tabId,
            surfaceTabId: surface.id,
            createdAt: Date.now(),
            connected: true,
            typed,
        },
    });
    await connectOrigin(origin);
    return { origin, tabId, typed };
}

/** Return only to the original tab if it still shows the chosen server. */
export async function returnToSetupTab(origin, tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (originOf(tab.url) !== origin)
        throw new Error(t("pairingOriginMismatch"));
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
}
