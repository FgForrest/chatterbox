import { SETUP_FLOW_KEY } from "./constants.js";
import { t } from "./i18n.js";
import { originOf, storePairing } from "./pairing.js";
import { activeSetupFlow } from "./setup-flow.js";

export { SETUP_FLOW_KEY } from "./constants.js";

export const PENDING_PAIR_KEY = "pendingPairing";

export async function queuePairing(
    message,
    senderOrigin,
    browser = chrome,
    senderTabId = null,
) {
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
    const flow = await activeSetupFlow(serverOrigin, senderTabId, browser);
    if (flow) {
        await storePairing({ serverUrl: serverOrigin, apiKey: message.apiKey });
        await browser.storage.session.set({
            [SETUP_FLOW_KEY]: { ...flow, completed: true },
        });
        await browser.storage.session.remove(PENDING_PAIR_KEY);
        const surface = await browser.tabs
            .get(flow.surfaceTabId)
            .catch(() => null);
        if (surface) {
            await browser.tabs
                .update(surface.id, { active: true })
                .catch(() => {});
            await browser.windows
                .update(surface.windowId, { focused: true })
                .catch(() => {});
        }
        return { ok: true };
    }
    await browser.storage.session.set({
        [PENDING_PAIR_KEY]: {
            serverUrl: serverOrigin,
            apiKey: message.apiKey,
            senderTabId,
        },
    });
    await browser.runtime.openOptionsPage();
    return { ok: true, pending: true };
}
