import { t } from "./i18n.js";
import { SETUP_FLOW_KEY } from "./constants.js";
import { originOf } from "./pairing.js";

export { SETUP_FLOW_KEY } from "./constants.js";

export const PENDING_PAIR_KEY = "pendingPairing";

export async function queuePairing(message, senderOrigin, browser = chrome, senderTabId = null) {
    if (
        typeof message.serverUrl !== "string" ||
        typeof message.apiKey !== "string"
    ) {
        throw new Error(t("pairingMissing"));
    }
    const serverOrigin = originOf(message.serverUrl);
    if (!serverOrigin || !senderOrigin || serverOrigin !== senderOrigin) {
        throw new Error(t("pairingOriginMismatch"));
    }
    if (!message.apiKey.trim()) {
        throw new Error(t("pairingMissingKey"));
    }
    await browser.storage.session.set({
        [PENDING_PAIR_KEY]: { serverUrl: serverOrigin, apiKey: message.apiKey, senderTabId },
    });
    const flow = (await browser.storage.session.get(SETUP_FLOW_KEY))[
        SETUP_FLOW_KEY
    ];
    if (
        flow?.origin === serverOrigin &&
        flow.tabId === senderTabId &&
        Date.now() - flow.createdAt < 15 * 60 * 1000 &&
        (await browser.permissions.contains({ origins: [`${serverOrigin}/*`] }))
    ) {
        const surface = await browser.tabs
            .get(flow.surfaceTabId)
            .catch(() => null);
        const expected = browser.runtime.getURL("options/options.html");
        if (surface?.url?.startsWith(`${expected}?`)) {
            await browser.tabs.update(surface.id, { active: true });
            await browser.windows.update(surface.windowId, { focused: true });
            return { ok: true, pending: true };
        }
    }
    await browser.runtime.openOptionsPage();
    return { ok: true, pending: true };
}
