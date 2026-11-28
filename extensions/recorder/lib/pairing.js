// Pairing helpers shared by the service worker, popup and options page:
// host-permission grants, pairing-relay registration, storing the pair, and
// fetching the server's recorder defaults.

import { clearAgendas, refreshAgendas } from "./agendas.js";
import { confirmPairing, getRecorderConfig, listRecordingSessions } from "./api.js";
import { listPendingCaptures, sessionForIntent, withPairingBinding } from "./capture-state.js";
import { SETUP_FLOW_KEY, STORAGE_KEYS } from "./constants.js";
import { t } from "./i18n.js";
import { offlineConfig } from "./sealed-recording.js";
import { reportConnection, sameConnection } from "./server-connection.js";
import { getSettings } from "./settings.js";
import { clearToken, readToken, storeToken } from "./token-vault.js";

const PAIRING_SCRIPT_ID = "riffado-pairing";
let installationIdPromise;

/** Persistent non-secret identifier for this browser installation. */
export function getInstallationId() {
    installationIdPromise ??= (async () => {
        const stored = await chrome.storage.local.get(
            STORAGE_KEYS.installationId,
        );
        if (stored[STORAGE_KEYS.installationId])
            return stored[STORAGE_KEYS.installationId];
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
export function grantHostAccess(origin) {
    return chrome.permissions.request({ origins: [`${origin}/*`] });
}

/** Register the relay for this exact origin without replacing other grants. */
export async function registerPairingScript(origin) {
    if (!origin || originOf(origin) !== origin || origin.includes("*")) return;
    if (!(await hasHostAccess(origin))) return;
    const script = {
        id: `${PAIRING_SCRIPT_ID}-${encodeURIComponent(origin)}`,
        js: ["content-pairing.js"],
        matches: [`${origin}/*`],
        runAt: "document_idle",
    };
    try {
        await chrome.scripting.registerContentScripts([script]);
    } catch {
        await chrome.scripting.updateContentScripts([script]);
    }
}

/** Register and inject the relay into open tabs of this exact origin. */
export async function connectOrigin(origin) {
    if (!origin || originOf(origin) !== origin || origin.includes("*"))
        throw new Error(t("pairingOriginMismatch"));
    if (!(await getSettings()).dataUseAcknowledgedAt)
        throw new Error(t("dataUseRequired"));
    if (!(await hasHostAccess(origin)))
        throw new Error(t("serverAccessDenied"));
    await registerPairingScript(origin);
    const tabs = await chrome.tabs.query({});
    await Promise.all(
        tabs
            .filter((tab) => originOf(tab.url) === origin)
            .map((tab) => injectPairingScript(tab.id)),
    );
}

/** Install relays for newly granted sites, including grants made in Chrome UI. */
export async function connectGrantedOrigins(origins) {
    const allowed = await pairingOrigins();
    const concrete = origins
        .map((pattern) => pattern.replace(/\/\*$/, ""))
        .filter((origin) => !origin.includes("*") && allowed.has(origin));
    await Promise.all([...new Set(concrete)].map(connectOrigin));
}

/** Origins explicitly chosen in setup or saved by a confirmed pairing. */
export async function pairingOrigins() {
    const settings = await getSettings();
    const origins = new Set();
    if (!settings.dataUseAcknowledgedAt) return origins;
    const paired = settings.hasApiKey ? originOf(settings.serverUrl) : null;
    if (paired) origins.add(paired);
    const flow = (await chrome.storage.session.get(SETUP_FLOW_KEY))[
        SETUP_FLOW_KEY
    ];
    if (
        flow &&
        Date.now() - flow.createdAt >= 0 &&
        Date.now() - flow.createdAt < 15 * 60 * 1000
    ) {
        const tab = await chrome.tabs.get(flow.tabId).catch(() => null);
        if (flow.origin && originOf(tab?.url) === flow.origin)
            origins.add(flow.origin);
    }
    return origins;
}

/** Reject messages from old relays after disconnect or access removal. */
export async function hasPairingRelayAccess(origin) {
    return (await pairingOrigins()).has(origin) && (await hasHostAccess(origin));
}

/** Remove stale relays, or every relay when disconnecting. */
export async function unregisterPairingScripts(all = false) {
    const allowed = all ? new Set() : await pairingOrigins();
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    const ids = [];
    for (const script of scripts) {
        if (
            script.id !== PAIRING_SCRIPT_ID &&
            !script.id.startsWith(`${PAIRING_SCRIPT_ID}-`)
        ) continue;
        const origin = script.matches?.[0]?.replace(/\/\*$/, "");
        if (
            script.matches?.length !== 1 ||
            !allowed.has(origin) ||
            !(await hasHostAccess(origin))
        )
            ids.push(script.id);
    }
    if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
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
export async function storePairing({
    serverUrl,
    apiKey,
    allowPendingRecovery = false,
}) {
    if (!(await getSettings()).dataUseAcknowledgedAt)
        throw new Error(t("dataUseRequired"));
    if (!(await hasHostAccess(originOf(serverUrl))))
        throw new Error(t("serverAccessDenied"));
    const cleanUrl = String(serverUrl).replace(/\/+$/, "");
    const previousDefaults = await withPairingBinding(async () => {
        const pending = (await listPendingCaptures()).filter(({ meta }) =>
            !meta?.pairing?.accountId || !meta.stoppedAt ||
            (meta.protocol !== 2 && meta.createOutcome === "unknown"));
        const current = await getSettings();
        const sameKey = current.hasApiKey && current.serverUrl === cleanUrl &&
            (await readToken().catch(() => null)) === String(apiKey);
        if (pending.length > 0) {
            if (!allowPendingRecovery) throw new Error(
                "Finish or discard pending encrypted recordings before changing the recorder key",
            );
            const local = pending.filter(({ meta }) => originOf(meta?.serverUrl) === originOf(cleanUrl));
            if (current.serverUrl !== cleanUrl || !local.length) {
                throw new Error("Pending recordings belong to another server");
            }
            if (!sameKey && local.some(({ meta }) => meta.pairing && !meta.stoppedAt)) {
                throw new Error("Finish or discard pending encrypted recordings before changing the recorder key");
            }
            const unknown = local.filter(({ meta }) => meta.createOutcome === "unknown");
            if (!sameKey && unknown.length) {
                const sessions = await listRecordingSessions({ serverUrl: cleanUrl, apiKey: String(apiKey) });
                if (unknown.some(({ meta }) => !sessionForIntent(sessions, meta.createIntent))) {
                    throw new Error("Finish or discard pending encrypted recordings before changing the recorder key");
                }
            }
        }
        await clearAgendas();
        if (!sameKey) {
            await chrome.storage.local.remove(STORAGE_KEYS.serverDefaults);
            await storeToken(String(apiKey));
        }
        await chrome.storage.local.set({ [STORAGE_KEYS.serverUrl]: cleanUrl });
        return originOf(current.serverUrl) === originOf(cleanUrl) ? current.serverDefaults : null;
    });
    await unregisterPairingScripts();
    await refreshServerConfig({ previousDefaults }).catch((error) =>
        console.warn("[recorder] config fetch after pairing failed:", error),
    );
    await confirmPairing(
        { serverUrl: cleanUrl, connectionId: (await getSettings()).connectionId, apiKey: String(apiKey) },
        await getInstallationId(),
    ).catch((error) =>
        console.warn(
            "[recorder] could not retire previous installation keys:",
            error,
        ),
    );
}

/**
 * Fetch `/api/v1/recorder/config` and store it as `serverDefaults`.
 * @returns {Promise<boolean>} whether a config was stored
 */
export async function refreshServerConfig({ previousDefaults = null } = {}) {
    const settings = await getSettings();
    if (
        !settings.dataUseAcknowledgedAt ||
        !settings.serverUrl ||
        !settings.hasApiKey
    ) return false;
    const auth = {
        serverUrl: settings.serverUrl,
        connectionId: settings.connectionId,
        apiKey: await readToken(),
    };
    const config = await getRecorderConfig(auth, { observe: false }).catch(async (error) => {
        await reportConnection(auth, error, { config: true });
        throw error;
    });
    const stored = await withPairingBinding(async () => {
        const latest = await getSettings();
        if (!latest.dataUseAcknowledgedAt || !sameConnection(settings, latest)) return false;
        const previous = config.account?.id && config.account.id === previousDefaults?.accountId
            ? previousDefaults : null;
        const offline = await offlineConfig(config, {
            ...latest, serverDefaults: latest.serverDefaults ?? previous,
        });
        const defaults = config?.defaults ?? {};
        await chrome.storage.local.set({
            [STORAGE_KEYS.serverDefaults]: {
                agendas: config.features?.agendas === true,
                nextMeeting: config.features?.nextMeeting === true,
                agendaLive: config.features?.agendaLive === true,
                agendaText: config.features?.agendaText === 1 ? 1 : 0,
                sessionAgenda: config.features?.sessionAgenda === true,
                agendaRooms: config.features?.agendaRooms === 1 ? 1 : 0,
                roomRecorders: config.features?.roomRecorders === 1 ? 1 : 0,
                encryptedRecordingProtocol: config.encrypted_recording_protocol,
                ...offline,
                recordingFolderOverride: config.recording_folder_override === true,
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
                noticeTextIsDefault: typeof defaults.notice_text_is_default === "boolean" ? defaults.notice_text_is_default : undefined,
                lockDefaults: defaults.lock_defaults === true,
                fetchedAt: new Date().toISOString(),
            },
        });
        return true;
    });
    if (!stored) return false;
    await reportConnection(auth, null, { config: true });
    if (config.features?.agendas === true) void refreshAgendas().catch(() => {});
    else await clearAgendas();
    return true;
}

/** Forget the pairing and the server defaults that came with it. */
export async function clearPairing() {
    await withPairingBinding(async () => {
        if ((await listPendingCaptures()).some(({ meta }) =>
            !meta?.stoppedAt || !meta.pairing?.accountId ||
            (meta.protocol !== 2 && meta.createOutcome === "unknown"))) {
            throw new Error(
                "Finish or discard pending encrypted recordings before disconnecting",
            );
        }
        await clearAgendas();
        await clearToken();
        await chrome.storage.session.remove([SETUP_FLOW_KEY, "pendingPairing"]);
        await unregisterPairingScripts(true);
        await chrome.storage.local.remove([
            STORAGE_KEYS.serverUrl,
            STORAGE_KEYS.serverDefaults,
        ]);
    });
}
