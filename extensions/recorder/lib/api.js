// Thin client for Chatterbox's recording-session API.
//
// Every call carries the recorder API key as a Bearer token and targets the
// paired server URL. Errors surface the server's JSON envelope message when
// there is one.

async function readError(response) {
    try {
        const body = await response.json();
        if (body && typeof body.error === "string") {
            return {
                message: body.error,
                code: typeof body.code === "string" ? body.code : null,
            };
        }
    } catch {
        // fall through
    }
    return { message: `Request failed (${response.status})`, code: null };
}

/**
 * @param {{serverUrl: string, apiKey: string}} auth
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function request(auth, path, init = {}) {
    const headers = new Headers(init.headers ?? {});
    headers.set("Authorization", `Bearer ${auth.apiKey}`);
    const response = await fetch(`${auth.serverUrl}${path}`, {
        ...init,
        headers,
    });
    if (!response.ok) {
        const { message, code } = await readError(response);
        const error = new Error(message);
        error.status = response.status;
        error.code = code;
        const retryAfter = response.headers.get("Retry-After");
        if (retryAfter) {
            const seconds = Number(retryAfter);
            const dateSeconds = (Date.parse(retryAfter) - Date.now()) / 1000;
            error.retryAfterSeconds = Number.isFinite(seconds)
                ? seconds
                : Number.isFinite(dateSeconds)
                  ? Math.max(0, dateSeconds)
                  : null;
        }
        throw error;
    }
    return response;
}

/**
 * Open a session.
 * @param {{serverUrl: string, apiKey: string}} auth
 * @param {Object} body
 */
export async function createSession(auth, body) {
    const response = await request(auth, "/api/v1/recording-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    return response.json();
}

/**
 * Upload one chunk. Idempotent server-side by (session, index, hash).
 * @param {{serverUrl: string, apiKey: string}} auth
 * @param {string} sessionId
 * @param {number} index
 * @param {Blob} blob
 * @param {string} sha256 hex digest of the blob bytes
 */
export async function uploadChunk(auth, sessionId, index, blob, sha256) {
    await request(
        auth,
        `/api/v1/recording-sessions/${sessionId}/chunks/${index}`,
        {
            method: "PUT",
            headers: {
                "Content-Type": "application/octet-stream",
                "X-Chunk-SHA256": sha256,
            },
            body: blob,
        },
    );
}

/**
 * @param {{serverUrl: string, apiKey: string}} auth
 * @param {string} sessionId
 */
export async function getSession(auth, sessionId) {
    const response = await request(
        auth,
        `/api/v1/recording-sessions/${sessionId}`,
    );
    return response.json();
}

/** Replace an expired or failed upload session for the same encrypted capture. */
export async function recoverSession(auth, sessionId) {
    const response = await request(
        auth,
        `/api/v1/recording-sessions/${sessionId}/recover`,
        { method: "POST" },
    );
    return response.json();
}

/**
 * @param {{serverUrl: string, apiKey: string}} auth
 * @param {string} sessionId
 * @param {{chunkCount: number, endedAt: string, stopReason: string}} body
 */
export async function completeSession(auth, sessionId, body) {
    const response = await request(
        auth,
        `/api/v1/recording-sessions/${sessionId}/complete`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        },
    );
    return response.json();
}

/**
 * @param {{serverUrl: string, apiKey: string}} auth
 * @param {string} sessionId
 */
export async function abortSession(auth, sessionId) {
    await request(auth, `/api/v1/recording-sessions/${sessionId}`, {
        method: "DELETE",
    });
}

/**
 * Server-pushed recorder defaults (auto platforms, quiet period, notice).
 * @param {{serverUrl: string, apiKey: string}} auth
 */
export async function getRecorderConfig(auth) {
    const response = await request(auth, "/api/v1/recorder/config");
    return response.json();
}

/** Retire older keys issued to the same installation after pairing succeeds. */
export async function confirmPairing(auth, installationId) {
    await request(auth, "/api/v1/recorder/confirm-pairing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationId }),
    });
}

/** Compute the lowercase hex SHA-256 of a Blob's bytes. */
export async function sha256Hex(blob) {
    const buffer = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}
