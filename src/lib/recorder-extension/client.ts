/**
 * Browser-side detection of, and pairing with, the Meeting Recorder extension.
 *
 * Three channels, tried in order:
 *  1. External messaging (`chrome.runtime.sendMessage(extensionId, ...)`):
 *     available when this page's origin is in the extension's
 *     `externally_connectable` list (the hosted origins). No content script,
 *     no grant.
 *  2. The pairing content script's `postMessage` handshake: available on any
 *     origin the extension has been granted access to.
 *  3. A `web_accessible_resources` image probe: presence only, any origin.
 *
 * Dependencies are injected so the state machine is testable without a DOM.
 */

export type RecorderExtensionChannel = "external" | "content";

export type RecorderExtensionState =
    | { kind: "not-installed" }
    | { kind: "installed-unreachable" }
    | {
          kind: "reachable";
          channel: RecorderExtensionChannel;
          paired: false;
          version?: string;
      }
    | {
          kind: "reachable";
          channel: RecorderExtensionChannel;
          paired: true;
          pairedTo: string | null;
          pairedHere: boolean;
          version?: string;
      };

export interface PairResult {
    ok: boolean;
    error?: string;
}

const PING = "riffado-recorder-ping";
const PRESENT = "riffado-recorder-present";
const PAIR = "riffado-recorder-pair";
const PAIR_RESULT = "riffado-recorder-pair-result";

interface PresenceReply {
    installed?: boolean;
    paired?: boolean;
    pairedTo?: string | null;
    version?: string;
    unreachable?: boolean;
}

type ExternalSendMessage = (
    extensionId: string,
    message: unknown,
    callback: (response: unknown) => void,
) => void;

export interface RecorderExtensionClientDeps {
    origin: string;
    /** Present only when the page can talk to the extension directly. */
    externalSendMessage?: ExternalSendMessage;
    externalLastError?: () => unknown;
    postMessage: (data: unknown, targetOrigin: string) => void;
    addMessageListener: (
        listener: (event: { data: unknown; origin: string }) => void,
    ) => () => void;
    probeImage: (url: string, timeoutMs: number) => Promise<boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function toState(
    reply: PresenceReply,
    channel: RecorderExtensionChannel,
    origin: string,
): RecorderExtensionState {
    const version =
        typeof reply.version === "string" ? reply.version : undefined;
    if (reply.paired) {
        const pairedTo =
            typeof reply.pairedTo === "string" ? reply.pairedTo : null;
        return {
            kind: "reachable",
            channel,
            paired: true,
            pairedTo,
            pairedHere: pairedTo === origin,
            version,
        };
    }
    return { kind: "reachable", channel, paired: false, version };
}

function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    fallback: T,
): Promise<T> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(fallback), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(fallback);
            },
        );
    });
}

export function createRecorderExtensionClient(
    deps: RecorderExtensionClientDeps,
) {
    function externalPing(
        extensionId: string,
        timeoutMs: number,
    ): Promise<PresenceReply | null> {
        const send = deps.externalSendMessage;
        if (!send) return Promise.resolve(null);
        const attempt = new Promise<PresenceReply | null>((resolve) => {
            try {
                send(extensionId, { type: PING }, (response) => {
                    if (deps.externalLastError?.()) {
                        resolve(null);
                        return;
                    }
                    resolve(
                        isRecord(response) && response.installed
                            ? (response as PresenceReply)
                            : null,
                    );
                });
            } catch {
                resolve(null);
            }
        });
        return withTimeout(attempt, timeoutMs, null);
    }

    function contentPing(timeoutMs: number): Promise<PresenceReply | null> {
        const attempt = new Promise<PresenceReply | null>((resolve) => {
            const stop = deps.addMessageListener((event) => {
                if (event.origin !== deps.origin || !isRecord(event.data))
                    return;
                if (event.data.type !== PRESENT) return;
                stop();
                resolve(event.data as PresenceReply);
            });
            deps.postMessage({ type: PING }, deps.origin);
            setTimeout(stop, timeoutMs + 50);
        });
        return withTimeout(attempt, timeoutMs, null);
    }

    async function detect(
        extensionId: string,
        timeoutMs = 800,
    ): Promise<RecorderExtensionState> {
        const external = await externalPing(extensionId, timeoutMs);
        if (external) return toState(external, "external", deps.origin);

        const content = await contentPing(timeoutMs);
        if (content && !content.unreachable) {
            return toState(content, "content", deps.origin);
        }

        const installed = await deps.probeImage(
            `chrome-extension://${extensionId}/probe.png`,
            timeoutMs,
        );
        return installed
            ? { kind: "installed-unreachable" }
            : { kind: "not-installed" };
    }

    async function pair(
        extensionId: string,
        channel: RecorderExtensionChannel,
        payload: { serverUrl: string; apiKey: string },
        timeoutMs = 3000,
    ): Promise<PairResult> {
        if (channel === "external") {
            const send = deps.externalSendMessage;
            if (!send)
                return { ok: false, error: "External messaging unavailable" };
            const attempt = new Promise<PairResult>((resolve) => {
                try {
                    send(
                        extensionId,
                        { type: PAIR, ...payload },
                        (response) => {
                            if (deps.externalLastError?.()) {
                                resolve({
                                    ok: false,
                                    error: "Extension did not respond",
                                });
                                return;
                            }
                            if (isRecord(response) && response.ok === true) {
                                resolve({ ok: true });
                            } else {
                                resolve({
                                    ok: false,
                                    error:
                                        isRecord(response) &&
                                        typeof response.error === "string"
                                            ? response.error
                                            : "Pairing was refused",
                                });
                            }
                        },
                    );
                } catch (error) {
                    resolve({ ok: false, error: String(error) });
                }
            });
            return withTimeout(attempt, timeoutMs, {
                ok: false,
                error: "Timed out waiting for the extension",
            });
        }

        const attempt = new Promise<PairResult>((resolve) => {
            const stop = deps.addMessageListener((event) => {
                if (event.origin !== deps.origin || !isRecord(event.data))
                    return;
                if (event.data.type !== PAIR_RESULT) return;
                stop();
                if (event.data.ok === true) {
                    resolve({ ok: true });
                } else {
                    resolve({
                        ok: false,
                        error:
                            typeof event.data.error === "string"
                                ? event.data.error
                                : "Pairing was refused",
                    });
                }
            });
            deps.postMessage({ type: PAIR, ...payload }, deps.origin);
            setTimeout(stop, timeoutMs + 50);
        });
        return withTimeout(attempt, timeoutMs, {
            ok: false,
            error: "Timed out waiting for the extension",
        });
    }

    /** Fire whenever the content script announces itself (e.g. after a popup grant). */
    function onPresence(callback: (state: RecorderExtensionState) => void) {
        return deps.addMessageListener((event) => {
            if (event.origin !== deps.origin || !isRecord(event.data)) return;
            if (event.data.type !== PRESENT) return;
            callback(
                toState(event.data as PresenceReply, "content", deps.origin),
            );
        });
    }

    return { detect, pair, onPresence };
}

// ---- Browser wiring -----------------------------------------------------------

interface PageChrome {
    runtime?: {
        sendMessage?: ExternalSendMessage;
        lastError?: unknown;
    };
}

function pageChrome(): PageChrome | undefined {
    return (globalThis as { chrome?: PageChrome }).chrome;
}

function probeImageInBrowser(url: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const image = new Image();
        const timer = setTimeout(() => resolve(false), timeoutMs);
        image.onload = () => {
            clearTimeout(timer);
            resolve(true);
        };
        image.onerror = () => {
            clearTimeout(timer);
            resolve(false);
        };
        image.src = url;
    });
}

/** The client bound to the current page. Browser only. */
export function browserRecorderExtensionClient() {
    const chrome = pageChrome();
    const send = chrome?.runtime?.sendMessage;
    return createRecorderExtensionClient({
        origin: window.location.origin,
        externalSendMessage: send
            ? (id, message, callback) =>
                  send.call(chrome?.runtime, id, message, callback)
            : undefined,
        externalLastError: () => chrome?.runtime?.lastError,
        postMessage: (data, targetOrigin) =>
            window.postMessage(data, targetOrigin),
        addMessageListener: (listener) => {
            const handler = (event: MessageEvent) => {
                if (event.source !== window) return;
                listener({ data: event.data, origin: event.origin });
            };
            window.addEventListener("message", handler);
            return () => window.removeEventListener("message", handler);
        },
        probeImage: probeImageInBrowser,
    });
}
