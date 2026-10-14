import { IdentityProviderError } from "@/lib/identity/ports";

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

/** The Admin REST API of one realm, called with a server-held token. */
export interface KeycloakHttp {
    get<T>(path: string, query?: Record<string, string | number>): Promise<T>;
    getAll<T>(
        path: string,
        query?: Record<string, string | number>,
        pageSize?: number,
    ): Promise<T[]>;
    put(path: string, body?: unknown): Promise<void>;
    post(path: string, body?: unknown): Promise<void>;
    delete(path: string, body?: unknown): Promise<void>;
}

export interface KeycloakHttpOptions {
    baseUrl: string;
    realm: string;
    /** Supplies the bearer token at call time; never logged or returned. */
    token: () => Promise<string>;
    timeoutMs?: number;
    /** Sleep between retries; replaced in tests. */
    sleep?: (ms: number) => Promise<void>;
}

/** Map an HTTP status of the Admin API to an error kind. */
export function errorForStatus(status: number): IdentityProviderError {
    if (status === 401) {
        return new IdentityProviderError(
            "unauthorized",
            "The identity provider did not accept the administrator's token",
            status,
        );
    }
    if (status === 403) {
        return new IdentityProviderError(
            "forbidden",
            "The identity provider refused the delegated administration",
            status,
        );
    }
    if (status === 404) {
        return new IdentityProviderError(
            "not_found",
            "Not found at the identity provider",
            status,
        );
    }
    if (status === 409) {
        return new IdentityProviderError(
            "conflict",
            "The identity provider reported a conflict",
            status,
        );
    }
    if (status === 429) {
        return new IdentityProviderError(
            "rate_limited",
            "The identity provider is rate limiting",
            status,
        );
    }
    if (status >= 500) {
        return new IdentityProviderError(
            "unavailable",
            "The identity provider is unavailable",
            status,
        );
    }
    return new IdentityProviderError(
        "invalid_response",
        `Unexpected identity provider response ${status}`,
        status,
    );
}

function segment(value: string): string {
    return encodeURIComponent(value);
}

/** Build an Admin API path from literal parts and encoded identifiers. */
export function adminPath(
    strings: TemplateStringsArray,
    ...values: string[]
): string {
    return strings.reduce(
        (path, part, index) =>
            path + part + (index < values.length ? segment(values[index]) : ""),
        "",
    );
}

/**
 * A client of `<baseUrl>/admin/realms/<realm>`. Paths are relative to the
 * realm and built with {@link adminPath}; nothing a caller passes can
 * change the server or the realm. Idempotent calls (every call this
 * adapter makes) are retried on 429 and 502-504 with backoff.
 */
export function createKeycloakHttp(options: KeycloakHttpOptions): KeycloakHttp {
    const root = `${options.baseUrl.replace(/\/+$/, "")}/admin/realms/${segment(options.realm)}`;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const sleep =
        options.sleep ??
        ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

    async function call(
        method: string,
        path: string,
        query?: Record<string, string | number>,
        body?: unknown,
    ): Promise<Response> {
        if ((path !== "" && !path.startsWith("/")) || path.includes("..")) {
            throw new IdentityProviderError(
                "invalid_response",
                "Invalid identity provider path",
            );
        }
        const url = new URL(`${root}${path}`);
        for (const [key, value] of Object.entries(query ?? {})) {
            url.searchParams.set(key, String(value));
        }
        let lastError: IdentityProviderError | null = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            let response: Response;
            try {
                const token = await options.token();
                response = await fetch(url, {
                    method,
                    headers: {
                        authorization: `Bearer ${token}`,
                        accept: "application/json",
                        ...(body === undefined
                            ? {}
                            : { "content-type": "application/json" }),
                    },
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal: AbortSignal.timeout(timeoutMs),
                    redirect: "error",
                });
            } catch (error) {
                if (error instanceof IdentityProviderError) throw error;
                lastError = new IdentityProviderError(
                    "unavailable",
                    "The identity provider could not be reached",
                );
                if (attempt < MAX_ATTEMPTS) await sleep(200 * 2 ** attempt);
                continue;
            }
            if (response.ok) return response;
            await response.body?.cancel().catch(() => {});
            lastError = errorForStatus(response.status);
            if (!RETRY_STATUSES.has(response.status)) throw lastError;
            if (attempt < MAX_ATTEMPTS) {
                const retryAfter = Number(response.headers.get("retry-after"));
                await sleep(
                    Number.isFinite(retryAfter) && retryAfter > 0
                        ? Math.min(retryAfter, 5) * 1000
                        : 200 * 2 ** attempt,
                );
            }
        }
        throw (
            lastError ??
            new IdentityProviderError(
                "unavailable",
                "The identity provider is unavailable",
            )
        );
    }

    async function json<T>(response: Response): Promise<T> {
        try {
            return (await response.json()) as T;
        } catch {
            throw new IdentityProviderError(
                "invalid_response",
                "The identity provider sent an unreadable response",
                response.status,
            );
        }
    }

    return {
        async get<T>(path: string, query?: Record<string, string | number>) {
            return json<T>(await call("GET", path, query));
        },
        async getAll<T>(
            path: string,
            query: Record<string, string | number> = {},
            pageSize = 100,
        ) {
            const all: T[] = [];
            for (let first = 0; ; first += pageSize) {
                const page = await json<T[]>(
                    await call("GET", path, { ...query, first, max: pageSize }),
                );
                if (!Array.isArray(page)) {
                    throw new IdentityProviderError(
                        "invalid_response",
                        "The identity provider sent an unexpected list",
                    );
                }
                all.push(...page);
                if (page.length < pageSize) return all;
            }
        },
        async put(path: string, body?: unknown) {
            await call("PUT", path, undefined, body);
        },
        async post(path: string, body?: unknown) {
            await call("POST", path, undefined, body);
        },
        async delete(path: string, body?: unknown) {
            await call("DELETE", path, undefined, body);
        },
    };
}
