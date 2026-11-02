const MAX_INSPECTION_BYTES = 16_384;
const INSPECTION_TIMEOUT = 1_000;

type Listener = { onExpired: () => void };
let observation: { listeners: Set<Listener>; restore: () => void } | undefined;

function isAppApiUrl(value: string, base: string): boolean {
    const url = new URL(value, base);
    return (
        url.origin === new URL(base).origin &&
        url.pathname.startsWith("/api/") &&
        url.pathname !== "/api/auth" &&
        !url.pathname.startsWith("/api/auth/")
    );
}

async function inspectResponse(
    response: Response,
    onExpired: () => void,
    cancellations: Set<() => void>,
): Promise<void> {
    const reader = response.clone().body?.getReader();
    if (!reader) return;
    let cancelled = false;
    const cancel = () => {
        cancelled = true;
        void reader.cancel().catch(() => {});
    };
    cancellations.add(cancel);
    const timer = setTimeout(cancel, INSPECTION_TIMEOUT);
    try {
        const decoder = new TextDecoder();
        let text = "";
        let bytes = 0;
        while (!cancelled) {
            const { done, value } = await reader.read();
            if (cancelled) return;
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_INSPECTION_BYTES) {
                cancel();
                return;
            }
            text += decoder.decode(value, { stream: true });
        }
        const body: unknown = JSON.parse(text + decoder.decode());
        if (
            body !== null &&
            typeof body === "object" &&
            "code" in body &&
            body.code === "AUTH_SESSION_MISSING"
        ) {
            onExpired();
        }
    } finally {
        clearTimeout(timer);
        cancellations.delete(cancel);
        reader.releaseLock();
    }
}

/** Observe browser API expiry responses without consuming or delaying them. */
export function observeSessionExpiry(onExpired: () => void): () => void {
    if (!observation) {
        const originalFetch = window.fetch;
        const listeners = new Set<Listener>();
        const cancellations = new Set<() => void>();
        const observedFetch: typeof fetch = async (input, init) => {
            const recipients = [...listeners];
            const response = await originalFetch.call(window, input, init);
            if (listeners.size === 0 || response.status !== 401)
                return response;
            try {
                const requestedUrl =
                    typeof input === "string"
                        ? input
                        : input instanceof URL
                          ? input.href
                          : input.url;
                if (
                    isAppApiUrl(requestedUrl, window.location.href) &&
                    (!response.url ||
                        isAppApiUrl(response.url, window.location.href))
                ) {
                    void inspectResponse(
                        response,
                        () => {
                            for (const listener of recipients) {
                                if (listeners.has(listener))
                                    listener.onExpired();
                            }
                        },
                        cancellations,
                    ).catch(() => {});
                }
            } catch {}
            return response;
        };
        window.fetch = observedFetch;
        observation = {
            listeners,
            restore: () => {
                for (const cancel of cancellations) cancel();
                if (window.fetch === observedFetch)
                    window.fetch = originalFetch;
            },
        };
    }
    const current = observation;
    const listener = { onExpired };
    current.listeners.add(listener);
    return () => {
        current.listeners.delete(listener);
        if (current.listeners.size === 0 && observation === current) {
            current.restore();
            observation = undefined;
        }
    };
}
