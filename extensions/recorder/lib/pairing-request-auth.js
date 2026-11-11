import { request } from "./api.js";
import { t } from "./i18n.js";
import { getSettings } from "./settings.js";
import { readToken } from "./token-vault.js";

/** Send only while consent, capabilities and pairing still match the credential read. */
export async function pairingRequest(path, init, supported, expected, options) {
    const settings = expected ?? await getSettings();
    if (!supported(settings)) throw new Error(t("agendaUnsupported"));
    const apiKey = await readToken();
    const latest = await getSettings();
    if (!apiKey || !supported(latest) || latest.serverUrl !== settings.serverUrl || latest.connectionId !== settings.connectionId)
        throw new Error(t("agendaUnsupported"));
    return request({ serverUrl: settings.serverUrl, apiKey }, path, init, undefined, options);
}
