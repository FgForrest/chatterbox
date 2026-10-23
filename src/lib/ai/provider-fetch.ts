import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    createPinnedLookup,
    type PublicAddress,
    PublicHostnameResolutionError,
    resolvePublicHostname,
} from "@/lib/net/public-target";
import { providerMultipartBody, streamChunks } from "./provider-multipart";
import { HOSTED_LOCAL_BASE_URL_MESSAGE } from "./validate-base-url";

function knownBodyLength(body: RequestInit["body"]): number | null {
    if (typeof body === "string") return Buffer.byteLength(body);
    if (body instanceof URLSearchParams)
        return Buffer.byteLength(body.toString());
    if (body instanceof Blob) return body.size;
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body))
        return body.byteLength;
    return null;
}

function inputHref(input: RequestInfo | URL): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input.url;
}

async function resolveProviderTarget(
    input: RequestInfo | URL,
): Promise<{ url: URL; addresses: PublicAddress[] }> {
    try {
        const url = new URL(inputHref(input));
        if (
            (url.protocol !== "http:" && url.protocol !== "https:") ||
            url.username ||
            url.password
        ) {
            throw new Error("Invalid provider URL");
        }
        return { url, addresses: await resolvePublicHostname(url.hostname) };
    } catch (error) {
        if (error instanceof PublicHostnameResolutionError) {
            throw new AppError(
                ErrorCode.SERVICE_UNAVAILABLE,
                "The AI provider host could not be resolved. Please try again later.",
                503,
            );
        }
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            HOSTED_LOCAL_BASE_URL_MESSAGE,
            400,
            { field: "baseUrl" },
        );
    }
}

function responseDecompressor(encoding: string | null): Transform | null {
    switch (encoding) {
        case "gzip":
            return createGunzip();
        case "deflate":
            return createInflate();
        case "br":
            return createBrotliDecompress();
        default:
            return null;
    }
}

function providerResponse(
    incoming: IncomingMessage,
    status: number,
    method: string,
    url: URL,
): Response {
    const responseHeaders = new Headers();
    for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        responseHeaders.append(
            incoming.rawHeaders[i],
            incoming.rawHeaders[i + 1],
        );
    }
    let body: Readable = incoming;
    const decompress = responseDecompressor(
        responseHeaders.get("content-encoding"),
    );
    if (decompress) {
        body = decompress;
        void pipeline(incoming, decompress).catch((error: unknown) => {
            decompress.destroy(
                error instanceof Error
                    ? error
                    : new Error("Provider response failed"),
            );
        });
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");
    }
    const noBody =
        method === "HEAD" || status === 204 || status === 205 || status === 304;
    if (noBody) body.resume();
    const response = new Response(
        noBody ? null : (Readable.toWeb(body) as ReadableStream<Uint8Array>),
        {
            status,
            statusText: incoming.statusMessage,
            headers: responseHeaders,
        },
    );
    Object.defineProperty(response, "url", {
        value: url.toString(),
    });
    return response;
}

/**
 * Native fetch with Bun's socket idle timeout (five minutes) switched off,
 * so a provider that answers only once it is done, such as a long
 * transcription, is bounded by the caller's signal alone. Node ignores the
 * option.
 */
export const fetchWithoutIdleTimeout: typeof globalThis.fetch = (
    input,
    init,
) => {
    const options: RequestInit & { timeout: false } = {
        ...init,
        timeout: false,
    };
    return globalThis.fetch(input, options);
};

/** Hosted provider transport: resolve every request, pin DNS, and refuse redirects. Self-host uses `fetchWithoutIdleTimeout`. */
export const providerFetch: typeof globalThis.fetch = async (input, init) => {
    if (!env.IS_HOSTED) return fetchWithoutIdleTimeout(input, init);

    const { url, addresses } = await resolveProviderTarget(input);
    const callerSignal =
        init?.signal ?? (input instanceof Request ? input.signal : null);
    callerSignal?.throwIfAborted();
    const multipart =
        init?.body instanceof FormData
            ? providerMultipartBody(init.body)
            : null;
    const options = {
        ...init,
        ...(multipart ? { body: multipart.body } : {}),
        duplex: "half",
    };
    const request = new Request(input, options);
    request.signal.throwIfAborted();
    const headers = new Headers(request.headers);
    if (multipart) {
        headers.set("content-type", multipart.contentType);
        headers.set("content-length", multipart.contentLength);
    } else if (!headers.has("content-length")) {
        const length = knownBodyLength(init?.body);
        if (length !== null) headers.set("content-length", String(length));
    }
    headers.set("host", url.host);
    headers.set("accept-encoding", "identity");
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;

    return new Promise<Response>((resolve, reject) => {
        let incomingResponse: IncomingMessage | undefined;
        const outgoing = send(
            {
                protocol: url.protocol,
                hostname: url.hostname.replace(/^\[(.*)\]$/, "$1"),
                port: url.port || undefined,
                path: `${url.pathname}${url.search}`,
                method: request.method,
                headers: Object.fromEntries(headers),
                signal: request.signal,
                lookup: createPinnedLookup(addresses),
                agent: false,
            },
            (incoming) => {
                incomingResponse = incoming;
                const status = incoming.statusCode ?? 502;
                if (status >= 300 && status < 400 && status !== 304) {
                    incoming.destroy();
                    reject(new TypeError("Provider redirects are not allowed"));
                    return;
                }
                resolve(
                    providerResponse(incoming, status, request.method, url),
                );
            },
        );
        outgoing.on("error", reject);
        outgoing.setTimeout(300_000, () => {
            const error = new AppError(
                ErrorCode.SERVICE_UNAVAILABLE,
                "The AI provider connection timed out after 300 seconds of inactivity. Please try again later.",
                503,
            );
            incomingResponse?.destroy(error);
            outgoing.destroy(error);
        });
        if (request.body) {
            void pipeline(
                Readable.from(streamChunks(request.body)),
                outgoing,
            ).catch(reject);
        } else {
            outgoing.end();
        }
    });
};
