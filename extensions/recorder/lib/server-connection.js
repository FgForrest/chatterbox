import { t } from "./i18n.js";
import { getSettings } from "./settings.js";

export const SERVER_CONNECTION_KEY = "serverConnection";

export function isConnectionError(error) {
    return error?.kind === "offline" || error?.kind === "unreachable";
}

export function connectionError(kind, detail = {}) {
    const state = globalThis.navigator?.onLine === false ? "offline" : "unreachable";
    const connection = { state, detail: { kind, ...detail } };
    const notice = connectionNotice(connection);
    return Object.assign(new Error(kind === "timeout" ? t("requestTimedOut") : notice.message), {
        kind: state,
        detail: connection.detail,
        httpStatus: detail.httpStatus,
    });
}

export function sameConnection(a, b) {
    return Boolean(a && b && a.serverUrl === b.serverUrl && a.connectionId === b.connectionId);
}

export async function readServerConnection(settings) {
    settings ??= await getSettings();
    if (!settings.dataUseAcknowledgedAt || !settings.hasApiKey) return null;
    const connection = (await chrome.storage.session.get(SERVER_CONNECTION_KEY))[SERVER_CONNECTION_KEY];
    return sameConnection(connection, settings) ? connection : null;
}

export async function serverUnavailable(settings) {
    const connection = await readServerConnection(settings);
    return Boolean(connection && connection.state !== "ok");
}

let observer;

/** Install the worker's connection-state writer. Extension pages report to it by message. */
export function observeConnection(listener) {
    observer = listener;
}

export async function reportConnection(auth, error, { config = false } = {}) {
    if (!("connectionId" in auth) || (error && error.kind !== "server" && !isConnectionError(error))) return;
    const outcome = {
        serverUrl: auth.serverUrl,
        connectionId: auth.connectionId,
        state: isConnectionError(error) ? error.kind : "ok",
        detail: isConnectionError(error) ? error.detail : null,
        checkedAt: Date.now(),
        config,
    };
    try {
        if (observer) await observer(outcome);
        else await globalThis.chrome?.runtime?.sendMessage?.({ type: "recorder-connection-outcome", outcome });
    } catch {}
}

export function connectionNotice(connection, { recording = false, starting = false } = {}) {
    if (!connection || connection.state === "ok") return null;
    const { state, detail } = connection;
    const app = t("appName");
    return {
        message: state === "offline" ? t("connectionOffline") : t("connectionUnavailable", app),
        detail: detail?.kind === "timeout"
            ? t("connectionTimeoutDetail", String((detail.timeoutMs ?? 30000) / 1000))
            : detail?.kind === "foreign-response"
              ? detail.httpStatus
                  ? t("connectionHttpDetail", [String(detail.httpStatus), t("appNameGenitive", app)])
                  : t("connectionForeignDetail")
              : t("connectionNetworkDetail"),
        context: recording ? t("connectionRecording", app) :
            starting ? t("connectionStart", t("appNameInstrumental", app)) : null,
    };
}
