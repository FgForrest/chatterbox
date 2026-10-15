// Pairing helpers shared by the service worker, popup and options page:
// host-permission grants, pairing-relay registration, storing the pair, and
// fetching the server's recorder defaults.

import { confirmPairing, getRecorderConfig } from "./api.js";
import { listLocalSessions, readLocalMeta } from "./chunk-store.js";
import { STORAGE_KEYS } from "./constants.js";
import { getSettings } from "./settings.js";
import { clearToken, readToken, storeToken } from "./token-vault.js";

const PAIRING_SCRIPT_ID = "riffado-pairing";
let installationIdPromise;

/** Persistent non-secret identifier for this browser installation. */
export function getInstallationId() {
    installationIdPromise ??= (async () => {
        const stored = await chrome.storage.local.get(STORAGE_KEYS.installationId);
        if (stored[STORAGE_KEYS.installationId]) return stored[STORAGE_KEYS.installationId];
        const id = crypto.randomUUID();
        await chrome.storage.local.set({ [STORAGE_KEYS.installationId]: id });
        return id;
    })();
    return installationIdPromise;
}

/** `https://host[:port]` for a URL, or null. */
export function originOf(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            return null;
        }
        return parsed.origin;
    } catch {
        return null;
    }
}

export async function hasHostAccess(origin) {
    return chrome.permissions.contains({ origins: [`${origin}/*`] });
}

/**
 * Request host access to `origin`. Must be called from a user gesture in an
 * extension page (popup or options); Chrome rejects it anywhere else.
 * @returns {Promise<boolean>}
 */
export async function grantHostAccess(origin) {
    if (await hasHostAccess(origin)) return true;
    return chrome.permissions.request({ origins: [`${origin}/*`] });
}

/**
 * Register the pairing relay on `origin` for future page loads. Requires host
 * access to that origin. Best-effort: manual paste always works regardless.
 */
export async function registerPairingScript(origin) {
    try {
        await chrome.scripting.unregisterContentScripts({
            ids: [PAIRING_SCRIPT_ID],
        });
    } catch {
        // not registered yet
    }
    try {
        await chrome.scripting.registerContentScripts([
            {
                id: PAIRING_SCRIPT_ID,
                js: ["content-pairing.js"],
                matches: [`${origin}/*`],
                runAt: "document_idle",
            },
        ]);
    } catch (error) {
        console.warn("[recorder] could not register pairing script:", error);
    }
}

/** Inject the relay into an already-open tab so the page sees us without a reload. */
export async function injectPairingScript(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content-pairing.js"],
        });
    } catch (error) {
        console.warn("[recorder] could not inject pairing script:", error);
    }
}

/** Store the pair, then pull the server's defaults. */
export async function storePairing({ serverUrl, apiKey, allowPendingRecovery = false }) {
    const cleanUrl = String(serverUrl).replace(/\/+$/, "");
    const pending = await listLocalSessions();
    if (pending.length > 0) {
        if (!allowPendingRecovery) {
            throw new Error("Finish or discard pending encrypted recordings before changing the recorder key");
        }
        for (const id of pending) {
            const meta = await readLocalMeta(id);
            if (meta?.serverUrl !== cleanUrl) {
                throw new Error("Pending recordings belong to another server");
            }
        }
    }
    await storeToken(String(apiKey));
    await chrome.storage.local.set({ [STORAGE_KEYS.serverUrl]: cleanUrl });
    await refreshServerConfig().catch((error) =>
        console.warn("[recorder] config fetch after pairing failed:", error),
    );
    await confirmPairing(
        { serverUrl: cleanUrl, apiKey: String(apiKey) },
        await getInstallationId(),
    ).catch((error) =>
        console.warn("[recorder] could not retire previous installation keys:", error),
    );
}

/**
 * Fetch `/api/v1/recorder/config` and store it as `serverDefaults`.
 * @returns {Promise<boolean>} whether a config was stored
 */
export async function refreshServerConfig() {
    const settings = await getSettings();
    if (!settings.dataUseAcknowledgedAt || !settings.serverUrl || !settings.hasApiKey) return false;
    const config = await getRecorderConfig({
        serverUrl: settings.serverUrl,
        apiKey: await readToken(),
    });
    const defaults = config?.defaults ?? {};
    await chrome.storage.local.set({
        [STORAGE_KEYS.serverDefaults]: {
            encryptedRecordingProtocol: config.encrypted_recording_protocol,
            autoRecordPlatforms: Array.isArray(defaults.auto_record_platforms)
                ? defaults.auto_record_platforms.filter(
                      (id) => typeof id === "string",
                  )
                : [],
            autoStopQuietSeconds:
                typeof defaults.auto_stop_quiet_seconds === "number"
                    ? defaults.auto_stop_quiet_seconds
                    : 180,
            noticeText:
                typeof defaults.notice_text === "string"
                    ? defaults.notice_text
                    : "",
            noticeTextIsDefault: defaults.notice_text_is_default === true,
            lockDefaults: defaults.lock_defaults === true,
            fetchedAt: new Date().toISOString(),
        },
    });
    return true;
}

/** Forget the pairing and the server defaults that came with it. */
export async function clearPairing() {
    if ((await listLocalSessions()).length > 0) {
        throw new Error("Finish or discard pending encrypted recordings before disconnecting");
    }
    await clearToken();
    await chrome.storage.local.remove([
        STORAGE_KEYS.serverUrl,
        STORAGE_KEYS.serverDefaults,
    ]);
}
