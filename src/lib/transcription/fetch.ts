import { providerFetch } from "@/lib/ai/provider-fetch";
import { env } from "@/lib/env";
import { PublicHostnameResolutionError } from "@/lib/net/public-target";

const MAX_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const SOCKET_CLOSED_RETRY_WINDOW_MS = 5_000;

const NOT_CONNECTED_CODES = new Set([
    "ECONNREFUSED",
    "ConnectionRefused",
    "ENOTFOUND",
]);
const SOCKET_CLOSED_CODES = new Set(["ECONNRESET", "UND_ERR_SOCKET"]);

function stringCode(value: unknown): string | undefined {
    if (typeof value !== "object" || value === null || !("code" in value)) {
        return undefined;
    }
    return typeof value.code === "string" ? value.code : undefined;
}

function isRetryableConnectionError(error: unknown, elapsedMs: number) {
    if (
        !(error instanceof Error) ||
        error.name === "AbortError" ||
        error.name === "TimeoutError"
    ) {
        return false;
    }
    const code =
        error.cause instanceof PublicHostnameResolutionError
            ? error.cause.code
            : (stringCode(error) ?? stringCode(error.cause));
    return (
        code !== undefined &&
        (NOT_CONNECTED_CODES.has(code) ||
            (SOCKET_CLOSED_CODES.has(code) &&
                elapsedMs < SOCKET_CLOSED_RETRY_WINDOW_MS))
    );
}

function hasReplayableBody(
    input: RequestInfo | URL,
    body: RequestInit["body"],
): boolean {
    if (input instanceof Request && input.body !== null) return false;
    return !(
        body instanceof ReadableStream ||
        (typeof body === "object" &&
            body !== null &&
            Symbol.asyncIterator in body)
    );
}

function retryAfterMs(header: string | null): number | undefined {
    const value = header?.trim();
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
        return seconds >= 0
            ? Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS)
            : undefined;
    }
    const date = Date.parse(value);
    if (Number.isNaN(date)) return undefined;
    return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_DELAY_MS);
}

async function send(
    transport: typeof globalThis.fetch,
    input: RequestInfo | URL,
    init: RequestInit & { signal: AbortSignal },
): Promise<Response> {
    const { signal } = init;
    signal.throwIfAborted();
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
        return await Promise.race([transport(input, init), aborted.promise]);
    } finally {
        signal.removeEventListener("abort", onAbort);
    }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (ms === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

/** Retry rate limits and eligible pre-response failures within one transcription deadline. */
export async function fetchTranscription(
    input: RequestInfo | URL,
    init?: RequestInit,
    transport: typeof globalThis.fetch = providerFetch,
): Promise<Response> {
    const deadline = AbortSignal.timeout(env.WHISPER_REQUEST_TIMEOUT_MS);
    const callerSignal =
        init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = callerSignal
        ? AbortSignal.any([callerSignal, deadline])
        : deadline;
    const requestInit = { ...init, signal };
    const maxRetries = hasReplayableBody(input, init?.body) ? MAX_RETRIES : 0;

    for (let attempt = 0; ; attempt += 1) {
        const backoff = INITIAL_RETRY_DELAY_MS * 2 ** attempt;
        const startedAt = performance.now();
        let response: Response;
        try {
            response = await send(transport, input, requestInit);
        } catch (error) {
            if (
                attempt >= maxRetries ||
                signal.aborted ||
                !isRetryableConnectionError(
                    error,
                    performance.now() - startedAt,
                )
            ) {
                throw error;
            }
            await sleep(backoff, signal);
            continue;
        }

        if (response.status !== 429 || attempt >= maxRetries) return response;
        const delay =
            retryAfterMs(response.headers.get("retry-after")) ?? backoff;
        void response.body?.cancel().catch(() => undefined);
        await sleep(delay, signal);
    }
}
