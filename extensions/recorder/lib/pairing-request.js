import { t } from "./i18n.js";
import { originOf } from "./pairing.js";

export const PENDING_PAIR_KEY = "pendingPairing";

export async function queuePairing(message, senderOrigin, browser = chrome) {
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
        [PENDING_PAIR_KEY]: { serverUrl: serverOrigin, apiKey: message.apiKey },
    });
    await browser.runtime.openOptionsPage();
    return { ok: true, pending: true };
}
