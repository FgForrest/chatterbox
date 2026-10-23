import { ClientRequest, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as PublicTarget from "@/lib/net/public-target";

vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: true } }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/net/public-target", async (importOriginal) => ({
    ...(await importOriginal<typeof PublicTarget>()),
    resolvePublicHostname: vi.fn(async () => [
        { address: "127.0.0.1", family: 4 },
    ]),
}));

import { providerFetch } from "@/lib/ai/provider-fetch";
import { ErrorCode, mapErrorToAppError } from "@/lib/errors";
import { isRetryableError } from "@/lib/jobs/retryable";

let server: Server | undefined;

afterEach(async () => {
    vi.restoreAllMocks();
    const current = server;
    if (current) {
        await new Promise<void>((resolve, reject) => {
            current.close((error) => (error ? reject(error) : resolve()));
            current.closeAllConnections();
        });
    }
    server = undefined;
});

describe("hosted provider socket idle timeout", () => {
    it.each([
        "headers",
        "body",
        "gzip body",
    ])("destroys a socket stalled during %s with a retryable error", async (phase) => {
        server = createServer((_request, response) => {
            if (phase !== "headers") {
                if (phase === "gzip body")
                    response.setHeader("Content-Encoding", "gzip");
                response.flushHeaders();
            }
        });
        await new Promise<void>((resolve) =>
            server?.listen(0, "127.0.0.1", resolve),
        );
        const port = (server.address() as AddressInfo).port;
        const original = ClientRequest.prototype.setTimeout;
        const setTimeout = vi
            .spyOn(ClientRequest.prototype, "setTimeout")
            .mockImplementation(function (
                this: ClientRequest,
                timeout,
                callback,
            ) {
                expect(timeout).toBe(300_000);
                return original.call(this, 50, callback);
            });
        const pending = providerFetch(
            `http://api.example.com:${port}/v1/models`,
        )
            .then((response) => response.text())
            .catch((error: unknown) => error);
        const error = await pending;
        expect(setTimeout).toHaveBeenCalledTimes(1);
        expect(mapErrorToAppError(error)).toMatchObject({
            code: ErrorCode.SERVICE_UNAVAILABLE,
            statusCode: 503,
            message: expect.stringContaining("300 seconds of inactivity"),
        });
        expect(isRetryableError(error)).toBe(true);
    });
});
