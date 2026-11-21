import { once } from "node:events";
import { mkdtemp, readdir, readlink, rm, truncate } from "node:fs/promises";
import { createServer, get, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
    NodeNextRequest,
    NodeNextResponse,
} from "next/dist/server/base-http/node";
import { sendResponse } from "next/dist/server/send-response";
import {
    NextRequestAdapter,
    signalFromNodeResponse,
} from "next/dist/server/web/spec-extension/adapters/next-request";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, HEAD } from "@/app/api/recordings/[id]/audio/route";
import { db } from "@/db";
import { ErrorCode } from "@/lib/errors";
import { resolveByteRange } from "@/lib/storage/byte-range";
import {
    StorageObjectMissingError,
    StorageRangeNotSatisfiableError,
} from "@/lib/storage/errors";
import { createUserStorageProvider } from "@/lib/storage/factory";
import { LocalStorage } from "@/lib/storage/local-storage";
import { S3Storage } from "@/lib/storage/s3-storage";
import type { RequestedByteRange } from "@/lib/storage/types";

const storage = vi.hoisted(() => ({
    downloadFile: vi.fn(),
    downloadStream: vi.fn(),
    getObjectSize: vi.fn(),
    openRead: vi.fn(),
}));

vi.mock("@/db", () => ({ db: { select: vi.fn() } }));
vi.mock("@/lib/pipeline/trigger", () => ({ requestAdvanceInTx: vi.fn() }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({ user: { id: "reader" } }),
}));
vi.mock("@/lib/encryption/fields", () => ({ decryptText: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/sharing/access", () => ({
    requireRecordingAccess: vi.fn().mockResolvedValue({ ownerUserId: "owner" }),
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue(storage),
}));

const audio = Buffer.from("0123456789");
const MiB = 1024 * 1024;
const largeAudioSize = 6 * MiB;
const storagePath = "owner/recording.ogg";
const cutAt = new Date("2026-05-06T12:00:00.000Z");
const recording = {
    audioReapedAt: null as Date | null,
    cutAt,
    fileMd5: "audio-md5",
    storageFilename: "Recording.ogg",
    storagePath,
};

function selectRecording(row: typeof recording) {
    const query = {
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([row]),
    };
    vi.mocked(db.select).mockReturnValue(
        query as unknown as ReturnType<typeof db.select>,
    );
    return query;
}

function getAudio(
    range?: string,
    query = "",
    headers = new Headers(),
    method = "GET",
    signal?: AbortSignal,
) {
    if (range !== undefined) headers.set("Range", range);
    const handler = method === "HEAD" ? HEAD : GET;
    return handler(
        new Request(`http://localhost/api/recordings/rec-1/audio${query}`, {
            headers,
            method,
            signal,
        }),
        { params: Promise.resolve({ id: "rec-1" }) },
    );
}

async function listen(handler: RequestListener) {
    const server = createServer(handler).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    return {
        url: `http://127.0.0.1:${address.port}`,
        async close() {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

function s3At(endpoint: string) {
    return new S3Storage({
        endpoint,
        bucket: "recordings",
        region: "us-east-1",
        accessKeyId: "test-key",
        secretAccessKey: "test-secret",
    });
}

async function openFiles(path: string) {
    const fds = await readdir("/proc/self/fd");
    const files = await Promise.all(
        fds.map((fd) => readlink(`/proc/self/fd/${fd}`).catch(() => null)),
    );
    return files.filter((file) => file === path).length;
}

describe("recording audio over a socket", () => {
    let directory: string;
    let app: Awaited<ReturnType<typeof listen>>;
    let requestSignal: AbortSignal;
    let pipeError: unknown;

    beforeEach(async () => {
        vi.clearAllMocks();
        for (const operation of Object.values(storage)) operation.mockReset();
        selectRecording(recording);
        directory = await mkdtemp(join(tmpdir(), "audio-socket-"));
        pipeError = undefined;
        app = await listen(async (incoming, outgoing) => {
            const nextRequest = new NodeNextRequest(incoming);
            const request = NextRequestAdapter.fromBaseNextRequest(
                nextRequest,
                signalFromNodeResponse(outgoing),
            );
            requestSignal = request.signal;
            try {
                const handler = request.method === "HEAD" ? HEAD : GET;
                const response = await handler(request, {
                    params: Promise.resolve({ id: "rec-1" }),
                });
                await sendResponse(
                    nextRequest,
                    new NodeNextResponse(outgoing),
                    response,
                );
            } catch (error) {
                pipeError = error;
                outgoing.destroy();
            }
        });
    });

    afterEach(async () => {
        await app.close();
        await rm(directory, { recursive: true, force: true });
    });

    async function localFixture(size: number) {
        const path = join(directory, storagePath);
        const local = new LocalStorage(directory);
        await local.uploadFile(storagePath, Buffer.alloc(0), "audio/ogg");
        await truncate(path, size);
        return { path, local };
    }

    it.skipIf(process.platform !== "linux").each(["stalled", "mid-body"])(
        "releases the file when a %s client disconnects",
        async (mode) => {
            const { path, local } = await localFixture(24 * MiB);
            storage.openRead.mockImplementation(local.openRead.bind(local));
            const client = get(app.url);
            try {
                const [response] = await once(client, "response");
                if (mode === "stalled") {
                    response.pause();
                    await new Promise((resolve) => setTimeout(resolve, 100));
                } else {
                    await once(response, "data");
                }
                expect(await openFiles(path)).toBe(1);
                expect(response.complete).toBe(false);
                client.destroy();
                await vi.waitFor(async () => {
                    expect(requestSignal.aborted).toBe(true);
                    expect(await openFiles(path)).toBe(0);
                });
                expect(pipeError).toBeUndefined();
            } finally {
                client.destroy();
            }
        },
    );

    it("aborts the upstream HTTP request before S3 sends its headers", async () => {
        const started = Promise.withResolvers<void>();
        const disconnected = vi.fn();
        const upstream = await listen((_request, response) => {
            response.once("close", disconnected);
            started.resolve();
        });
        const s3 = s3At(upstream.url);
        storage.openRead.mockImplementation(s3.openRead.bind(s3));
        const client = get(app.url, { headers: { Range: "bytes=0-" } }).on(
            "error",
            () => {},
        );
        try {
            await started.promise;
            client.destroy();
            await vi.waitFor(() => {
                expect(requestSignal.aborted).toBe(true);
                expect(disconnected).toHaveBeenCalledTimes(1);
            });
        } finally {
            client.destroy();
            await upstream.close();
        }
    });

    it("aborts a 206 socket when the file ends before its advertised range", async () => {
        const { path, local } = await localFixture(24 * MiB);
        storage.openRead.mockImplementation(local.openRead.bind(local));
        const client = get(app.url, { headers: { Range: "bytes=0-" } });
        try {
            const [response] = await once(client, "response");
            expect(response.statusCode).toBe(206);
            response.pause();
            await truncate(path, 256 * 1024);
            const closed = new Promise<void>((resolve) =>
                response.once("close", resolve),
            );
            response.on("error", () => {});
            response.resume();
            await closed;
            expect(response.complete).toBe(false);
            expect(response.aborted).toBe(true);
            if (process.platform === "linux")
                expect(await openFiles(path)).toBe(0);
        } finally {
            client.destroy();
        }
    });
});

function openAudio(data: Buffer) {
    return async (_key: string, requested: RequestedByteRange | null) => {
        const range = resolveByteRange(requested, data.length);
        const bytes = range ? data.subarray(range.start, range.end + 1) : data;
        return {
            body: new Response(new Uint8Array(bytes)).body,
            totalSize: data.length,
            range,
        };
    };
}

const s3ResponseShapes = [
    "206 Content-Range",
    "200 Content-Length",
    "200 chunked",
    "416 Content-Range",
    "416 without size",
] as const;

const s3Requests: ReadonlyArray<{
    name: string;
    range?: string;
    size: number;
    interval?: [number, number];
    statuses: readonly number[];
}> = [
    { name: "no Range", size: 10, statuses: [200, 200, 200, 500, 500] },
    { name: "no Range, empty", size: 0, statuses: [200, 200, 200, 500, 500] },
    {
        name: "bounded",
        range: "bytes=2-5",
        size: 10,
        interval: [2, 5],
        statuses: [206, 500, 500, 416, 416],
    },
    {
        name: "bounded outside",
        range: "bytes=2-5",
        size: 2,
        statuses: [416, 416, 416, 416, 416],
    },
    {
        name: "open-ended",
        range: "bytes=2-",
        size: 10,
        interval: [2, 9],
        statuses: [206, 500, 500, 416, 416],
    },
    {
        name: "open-ended outside",
        range: "bytes=2-",
        size: 2,
        statuses: [416, 416, 416, 416, 416],
    },
    {
        name: "suffix",
        range: "bytes=-3",
        size: 10,
        interval: [7, 9],
        statuses: [206, 500, 500, 416, 416],
    },
    {
        name: "suffix, empty",
        range: "bytes=-3",
        size: 0,
        statuses: [200, 200, 200, 200, 200],
    },
    {
        name: "zero suffix",
        range: "bytes=-0",
        size: 10,
        statuses: [416, 416, 416, 416, 416],
    },
    {
        name: "zero suffix, empty",
        range: "bytes=-0",
        size: 0,
        statuses: [416, 416, 416, 416, 416],
    },
    {
        name: "past end",
        range: "bytes=20-",
        size: 10,
        statuses: [416, 416, 416, 416, 416],
    },
    {
        name: "start on empty",
        range: "bytes=0-",
        size: 0,
        statuses: [416, 416, 416, 416, 416],
    },
];

const s3Matrix = s3Requests.flatMap((test) =>
    s3ResponseShapes.map((shape, index) => ({
        ...test,
        shape,
        status: test.statuses[index],
    })),
);

describe("recording audio ranges", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        selectRecording(recording);
        storage.getObjectSize.mockResolvedValue(audio.length);
        storage.openRead.mockImplementation(openAudio(audio));
    });

    it.each(s3Matrix)("S3 response matrix $name / $shape", async (test) => {
        const payload = audio.subarray(0, test.size);
        const [start, end] = test.interval ?? [0, Math.max(0, test.size - 1)];
        const partial = `bytes ${start}-${end}/${test.size}`;
        const unsatisfiable = `bytes */${test.size}`;
        const upstream = await listen((request, response) => {
            if (request.method === "HEAD") {
                response.writeHead(200, { "Content-Length": test.size }).end();
                return;
            }
            if (test.range && !request.headers.range) {
                response
                    .writeHead(200, { "Content-Length": test.size })
                    .end(payload);
                return;
            }
            switch (test.shape) {
                case "206 Content-Range": {
                    const bytes = payload.subarray(start, end + 1);
                    response
                        .writeHead(206, {
                            "Content-Range": partial,
                            "Content-Length": bytes.length,
                        })
                        .end(bytes);
                    break;
                }
                case "200 Content-Length":
                    response
                        .writeHead(200, { "Content-Length": test.size })
                        .end(payload);
                    break;
                case "200 chunked":
                    response
                        .writeHead(200, { "Transfer-Encoding": "chunked" })
                        .end(payload);
                    break;
                default:
                    if (test.shape === "416 Content-Range") {
                        response.setHeader("Content-Range", unsatisfiable);
                    }
                    response
                        .writeHead(416, { "Content-Type": "application/xml" })
                        .end(
                            "<Error><Code>InvalidRange</Code><Message>Invalid range</Message></Error>",
                        );
                    break;
            }
        });
        const s3 = s3At(upstream.url);
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        storage.openRead.mockImplementation(s3.openRead.bind(s3));

        try {
            const response = await getAudio(test.range);
            const actual = {
                status: response.status,
                contentRange: response.headers.get("Content-Range"),
            };
            const expected = {
                status: test.status,
                contentRange:
                    test.status === 206
                        ? partial
                        : test.status === 416
                          ? unsatisfiable
                          : null,
            };
            expect(actual).toEqual(expected);
            if (response.status === 200 || response.status === 206) {
                expect(await response.text()).toBe(
                    (response.status === 206
                        ? payload.subarray(start, end + 1)
                        : payload
                    ).toString(),
                );
            }
        } finally {
            log.mockRestore();
            await upstream.close();
        }
    });

    it.each([
        "playback",
        "attachment",
        "If-Range",
    ])("streams a chunked S3 200 with no length for %s", async (mode) => {
        const seen = vi.fn();
        const upstream = await listen((request, response) => {
            seen(request.method, request.headers.range);
            response.write("0123");
            response.end("456789");
        });
        const s3 = s3At(upstream.url);
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        storage.openRead.mockImplementation(s3.openRead.bind(s3));

        try {
            const headers = new Headers();
            if (mode === "If-Range") headers.set("If-Range", '"old"');
            const response = await getAudio(
                mode === "playback" ? undefined : "bytes=2-5",
                mode === "attachment" ? "?download=1" : "",
                headers,
            );
            expect(response.status).toBe(200);
            expect(response.headers.get("Content-Length")).toBeNull();
            expect(response.headers.get("Content-Range")).toBeNull();
            expect(response.headers.has("Content-Disposition")).toBe(
                mode === "attachment",
            );
            expect(await response.text()).toBe("0123456789");
            expect(seen).toHaveBeenCalledExactlyOnceWith("GET", undefined);
            expect(log).not.toHaveBeenCalled();
        } finally {
            log.mockRestore();
            await upstream.close();
        }
    });

    it.each([
        "extra chunk",
        "no terminating chunk",
    ])("fails after the promised bytes of a chunked S3 206 with %s", async (framing) => {
        const finish = Promise.withResolvers<void>();
        const upstream = await listen((_request, response) => {
            response.writeHead(206, {
                "Content-Range": "bytes 2-5/10",
                "Transfer-Encoding": "chunked",
            });
            response.write("2345");
            void finish.promise.then(() => {
                if (framing === "extra chunk") response.end("6");
                else response.destroy();
            });
        });
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        const s3 = s3At(upstream.url);
        storage.openRead.mockImplementation(s3.openRead.bind(s3));

        try {
            const response = await getAudio("bytes=2-5");
            expect(response.status).toBe(206);
            const reader = response.body?.getReader();
            if (!reader) throw new Error("Expected a streaming 206 body");
            const first = await reader.read();
            expect(first.done).toBe(false);
            expect(Buffer.from(first.value ?? []).toString()).toBe("2345");

            finish.resolve();
            await expect(reader.read()).rejects.toThrow(
                framing === "extra chunk"
                    ? "exceeds the promised length"
                    : "Could not read the storage body",
            );
            expect(log).toHaveBeenCalledTimes(1);
        } finally {
            finish.resolve();
            log.mockRestore();
            await upstream.close();
        }
    });

    it.each([
        "playback",
        "range",
    ])("keeps S3 AccessDenied object keys out of %s errors and API logs", async (mode) => {
        const resource = `/recordings/${storagePath}`;
        const upstream = await listen((_request, response) => {
            response.writeHead(403, { "Content-Type": "application/xml" });
            response.end(
                `<Error><Code>AccessDenied</Code><Message>Denied for ${resource}</Message><Resource>${resource}</Resource></Error>`,
            );
        });
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        const s3 = s3At(upstream.url);
        storage.openRead.mockImplementation(s3.openRead.bind(s3));

        try {
            const requested =
                mode === "range" ? { start: BigInt(2), end: BigInt(5) } : null;
            const failure = await s3
                .openRead(storagePath, requested)
                .catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(Error);
            const diagnostic =
                "Failed to download file from S3 (AccessDenied, HTTP 403)";
            expect(failure).toHaveProperty("message", diagnostic);
            expect(inspect(failure, { depth: Infinity })).not.toContain(
                storagePath,
            );
            expect(failure).not.toHaveProperty("Resource");

            const response = await getAudio(
                mode === "range" ? "bytes=2-5" : undefined,
            );
            expect(response.status).toBe(500);
            expect(log).toHaveBeenCalledTimes(1);
            const logged = inspect(log.mock.calls, { depth: Infinity });
            expect(logged).toContain(diagnostic);
            expect(logged).not.toContain(storagePath);
            expect(await response.text()).not.toContain(storagePath);
        } finally {
            log.mockRestore();
            await upstream.close();
        }
    });

    it("returns 416 when a ranged S3 GET fails but HEAD shows the range is unsatisfiable", async () => {
        const seen = vi.fn();
        const upstream = await listen((request, response) => {
            seen(request.method, request.headers.range);
            if (request.method === "HEAD") {
                response.writeHead(200, { "Content-Length": 10 }).end();
                return;
            }
            response
                .writeHead(403, { "Content-Type": "application/xml" })
                .end(
                    "<Error><Code>InvalidObjectState</Code><Message>Object is archived</Message></Error>",
                );
        });
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        const s3 = s3At(upstream.url);
        storage.openRead.mockImplementation(s3.openRead.bind(s3));

        try {
            const response = await getAudio("bytes=20-");
            expect(response.status).toBe(416);
            expect(response.headers.get("Content-Range")).toBe("bytes */10");
            expect(response.body).toBeNull();
            expect(seen.mock.calls).toEqual([
                ["GET", "bytes=20-"],
                ["HEAD", undefined],
            ]);
            expect(log).not.toHaveBeenCalled();
        } finally {
            log.mockRestore();
            await upstream.close();
        }
    });

    it("returns an unlogged 499 when the SDK wraps an abort during the S3 HEAD probe", async () => {
        const probe = Promise.withResolvers<void>();
        const seen = vi.fn();
        const closed = vi.fn();
        const upstream = await listen((request, response) => {
            seen(request.method, request.headers.range);
            if (request.method === "HEAD") {
                response.writeHead(404);
                response.end();
                return;
            }
            response.once("close", closed);
            probe.resolve();
        });
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        const s3 = s3At(upstream.url);
        storage.getObjectSize.mockImplementation(s3.getObjectSize.bind(s3));
        const controller = new AbortController();

        try {
            const pending = getAudio(
                undefined,
                "",
                new Headers(),
                "HEAD",
                controller.signal,
            );
            await probe.promise;
            controller.abort(new Error("client disconnected"));
            const response = await pending;
            expect(response.status).toBe(499);
            expect(response.body).toBeNull();
            expect(seen.mock.calls).toEqual([
                ["HEAD", undefined],
                ["GET", "bytes=0-0"],
            ]);
            expect(log).not.toHaveBeenCalled();
            await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
        } finally {
            log.mockRestore();
            await upstream.close();
        }
    });

    it.each([
        ["the request reason", (reason: Error) => reason],
        [
            "a nested cause",
            (reason: Error) =>
                new Error("Request failed", {
                    cause: new Error("Read failed", { cause: reason }),
                }),
        ],
        [
            "a named abort",
            () => new DOMException("Request aborted", "AbortError"),
        ],
    ] as const)("returns a quiet 499 for %s", async (_description, abortError) => {
        const controller = new AbortController();
        const reason = new Error("Client disconnected");
        selectRecording(recording).limit.mockImplementation(async () => {
            controller.abort(reason);
            throw abortError(reason);
        });
        const log = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
            const response = await getAudio(
                undefined,
                "",
                new Headers(),
                "GET",
                controller.signal,
            );
            expect(response.status).toBe(499);
            expect(response.body).toBeNull();
            expect(log).not.toHaveBeenCalled();
        } finally {
            log.mockRestore();
        }
    });

    it.each([
        [
            "a database failure racing a disconnect",
            true,
            new Error("Database read failed"),
        ],
        [
            "an AbortError on an active request",
            false,
            new DOMException("Read aborted", "AbortError"),
        ],
    ] as const)("logs %s as a server failure", async (_description, disconnect, failure) => {
        const controller = new AbortController();
        selectRecording(recording).limit.mockImplementation(async () => {
            if (disconnect) controller.abort(new Error("Client disconnected"));
            throw failure;
        });
        const log = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
            const response = await getAudio(
                undefined,
                "",
                new Headers(),
                "GET",
                controller.signal,
            );
            expect(response.status).toBe(500);
            expect(log).toHaveBeenCalledTimes(1);
            expect(log.mock.calls[0][2]).toBe(failure);
        } finally {
            log.mockRestore();
        }
    });

    it.each([
        ["bytes=2-4", 2, 4, "234"],
        ["bytes=6-", 6, 9, "6789"],
        ["bytes=-3", 7, 9, "789"],
        ["BYTES=0-0", 0, 0, "0"],
        ["bytes=8-99", 8, 9, "89"],
        ["bytes=8-999999999999999999999999", 8, 9, "89"],
        ["bytes=-999999999999999999999999", 0, 9, "0123456789"],
    ])("serves %s through the app", async (range, start, end, body) => {
        const response = await getAudio(
            range,
            `?v=${encodeURIComponent(cutAt.toISOString())}`,
            new Headers({ "Sec-Fetch-Dest": "audio" }),
        );

        expect(response.status).toBe(206);
        expect(response.headers.get("Content-Range")).toBe(
            `bytes ${start}-${end}/10`,
        );
        expect(response.headers.get("Content-Length")).toBe(
            String(body.length),
        );
        expect(response.headers.get("Content-Type")).toBe("audio/ogg");
        expect(response.headers.get("Content-Disposition")).toBeNull();
        expect(response.headers.get("Accept-Ranges")).toBe("bytes");
        expect(response.headers.get("Cache-Control")).toBe(
            "private, max-age=31536000, immutable",
        );
        expect(response.headers.get("X-Audio-Md5")).toBe(recording.fileMd5);
        expect(response.headers.get("X-Recording-Cut-At")).toBe(
            cutAt.toISOString(),
        );
        expect(await response.text()).toBe(body);
        expect(createUserStorageProvider).toHaveBeenCalledWith("owner");
        expect(storage.getObjectSize).not.toHaveBeenCalled();
        expect(storage.openRead).toHaveBeenCalledTimes(1);
        expect(storage.downloadFile).not.toHaveBeenCalled();
    });

    it.each([
        "bytes=10-",
        "bytes=-0",
        "bytes=999999999999999999999999-",
    ])("maps the adapter's rejection of %s to 416 with Content-Range", async (range) => {
        const response = await getAudio(range);

        expect(response.status).toBe(416);
        expect(response.headers.get("Content-Range")).toBe("bytes */10");
        expect(response.body).toBeNull();
        expect(storage.getObjectSize).not.toHaveBeenCalled();
        expect(storage.downloadFile).not.toHaveBeenCalled();
    });

    it.each([
        undefined,
        "bytes=1-3,6-8",
        "bytes=1-3junk",
        "junkbytes=1-3",
        "items=1-3",
        "bytes=3-1",
        "bytes=999999999999999999999999-999999999999999999999998",
        "bytes=-",
    ])("returns all bytes for range %s", async (range) => {
        const response = await getAudio(range);

        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Range")).toBeNull();
        expect(response.headers.get("Content-Length")).toBe("10");
        expect(await response.text()).toBe(audio.toString());
        expect(storage.openRead).toHaveBeenCalledExactlyOnceWith(
            storagePath,
            null,
            expect.any(AbortSignal),
        );
        expect(storage.getObjectSize).not.toHaveBeenCalled();
        expect(storage.downloadFile).not.toHaveBeenCalled();
    });

    it("sends the whole object when If-Range cannot be matched", async () => {
        const response = await getAudio(
            "bytes=1-3",
            "",
            new Headers({ "If-Range": '"old"' }),
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(audio.toString());
    });

    it("handles ranges on an empty object", async () => {
        storage.openRead.mockImplementation(openAudio(Buffer.alloc(0)));

        const response = await getAudio("bytes=0-");
        expect(response.status).toBe(416);
        expect(response.headers.get("Content-Range")).toBe("bytes */0");

        const suffix = await getAudio("bytes=-1");
        expect(suffix.status).toBe(200);
        expect(suffix.headers.get("Content-Length")).toBe("0");
        expect(await suffix.text()).toBe("");
    });

    it.each([
        [`bytes=${MiB}-`, MiB, largeAudioSize - 1],
        [`bytes=${MiB}-${4 * MiB - 1}`, MiB, 4 * MiB - 1],
        [`bytes=-${3 * MiB}`, 3 * MiB, largeAudioSize - 1],
        [`bytes=${5 * MiB}-`, 5 * MiB, largeAudioSize - 1],
    ])("reads and serves the exact interval for %s", async (range, start, end) => {
        const largeAudio = Buffer.alloc(largeAudioSize);
        largeAudio[start] = 0x12;
        largeAudio[end] = 0x34;
        storage.openRead.mockImplementationOnce(openAudio(largeAudio));

        const response = await getAudio(range);

        expect(response.status).toBe(206);
        expect(response.headers.get("Content-Range")).toBe(
            `bytes ${start}-${end}/${largeAudioSize}`,
        );
        expect(response.headers.get("Content-Length")).toBe(
            String(end - start + 1),
        );
        const body = new Uint8Array(await response.arrayBuffer());
        expect(body.byteLength).toBe(end - start + 1);
        expect(body[0]).toBe(0x12);
        expect(body.at(-1)).toBe(0x34);
        expect(storage.openRead).toHaveBeenCalledTimes(1);
        expect(storage.getObjectSize).not.toHaveBeenCalled();
        expect(storage.downloadFile).not.toHaveBeenCalled();
        expect(storage.downloadStream).not.toHaveBeenCalled();
    });

    it("uses bytes and size from the same read after a replacement", async () => {
        storage.openRead.mockImplementationOnce(
            openAudio(Buffer.from("01234567")),
        );

        const response = await getAudio("bytes=2-");

        expect(response.status).toBe(206);
        expect(storage.openRead).toHaveBeenCalledExactlyOnceWith(
            storagePath,
            { start: BigInt(2), end: null },
            expect.any(AbortSignal),
        );
        expect(storage.getObjectSize).not.toHaveBeenCalled();
        expect(response.headers.get("Content-Range")).toBe("bytes 2-7/8");
        expect(response.headers.get("Content-Length")).toBe("6");
        expect(await response.text()).toBe("234567");
    });

    it("returns 416 with the latest size if a replacement invalidates the range", async () => {
        storage.openRead.mockRejectedValueOnce(
            new StorageRangeNotSatisfiableError(8),
        );

        const response = await getAudio("bytes=8-");

        expect(response.status).toBe(416);
        expect(response.headers.get("Content-Range")).toBe("bytes */8");
        expect(response.body).toBeNull();
    });

    it.each([
        undefined,
        "bytes=1-3",
    ])("answers HEAD with range %s using only metadata", async (range) => {
        const response = await getAudio(range, "", new Headers(), "HEAD");

        expect(response.status).toBe(200);
        expect(response.body).toBeNull();
        expect(response.headers.get("Content-Length")).toBe("10");
        expect(response.headers.get("Content-Range")).toBeNull();
        expect(response.headers.get("X-Audio-Md5")).toBe(recording.fileMd5);
        expect(storage.getObjectSize).toHaveBeenCalledExactlyOnceWith(
            storagePath,
            expect.any(AbortSignal),
        );
        expect(storage.openRead).not.toHaveBeenCalled();
        expect(storage.downloadFile).not.toHaveBeenCalled();
        expect(storage.downloadStream).not.toHaveBeenCalled();
    });

    it("returns a complete, uncached attachment even with an unsatisfiable range", async () => {
        const response = await getAudio("bytes=1000-", "?download=1");

        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Length")).toBe("10");
        expect(response.headers.get("Content-Disposition")).toContain(
            'attachment; filename="Recording.ogg"',
        );
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(response.headers.get("Content-Range")).toBeNull();
        expect(await response.text()).toBe(audio.toString());
        expect(storage.openRead).toHaveBeenCalledExactlyOnceWith(
            storagePath,
            null,
            expect.any(AbortSignal),
        );
        expect(storage.getObjectSize).not.toHaveBeenCalled();
        expect(storage.downloadFile).not.toHaveBeenCalled();
    });

    it.each([
        ["HEAD", "bytes=0-0", "getObjectSize"],
        ["GET", "bytes=0-0", "openRead"],
        ["GET", undefined, "openRead"],
    ] as const)("returns 404 for %s with range %s when the object is missing", async (method, range, operation) => {
        storage[operation].mockRejectedValueOnce(
            new StorageObjectMissingError(),
        );

        const response = await getAudio(range, "", new Headers(), method);

        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
            code: ErrorCode.RECORDING_NOT_FOUND,
        });
    });

    it("returns 410 for retention-reaped audio before touching storage", async () => {
        selectRecording({ ...recording, audioReapedAt: cutAt });

        const response = await getAudio("bytes=0-0");

        expect(response.status).toBe(410);
        expect(await response.json()).toMatchObject({
            code: ErrorCode.RECORDING_DATA_REAPED,
        });
        expect(createUserStorageProvider).not.toHaveBeenCalled();
    });
});
