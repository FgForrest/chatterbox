import { t } from "./i18n.js";
import { connectOrigin, grantHostAccess, originOf } from "./pairing.js";
import { SETUP_FLOW_KEY } from "./pairing-request.js";
import { saveSettings } from "./settings.js";

/** Continue a toolbar setup, requesting site access on the caller's gesture. */
export async function prepareOriginSetup(
    { origin, tabId },
    acknowledge = false,
) {
    const access = grantHostAccess(origin);
    if (acknowledge)
        await saveSettings({ dataUseAcknowledgedAt: new Date().toISOString() });
    if (!(await access)) throw new Error(t("serverAccessDenied"));
    const tab = await chrome.tabs.get(tabId);
    if (originOf(tab.url) !== origin)
        throw new Error(t("pairingOriginMismatch"));
    const surface = await chrome.tabs.getCurrent();
    await chrome.storage.session.set({
        [SETUP_FLOW_KEY]: {
            origin,
            tabId,
            surfaceTabId: surface.id,
            createdAt: Date.now(),
            connected: true,
        },
    });
    await connectOrigin(origin);
}

/** Return only to the original tab if it still shows the chosen server. */
export async function returnToSetupTab(origin, tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (originOf(tab.url) !== origin)
        throw new Error(t("pairingOriginMismatch"));
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
}
