import {
    chmod,
    mkdtemp,
    open,
    rename,
    rm,
    stat,
    unlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import {
    GetObjectCommand,
    HeadObjectCommand,
    NoSuchKey,
    S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    StorageObjectChangedError,
    StorageObjectMissingError,
    StorageRangeNotSatisfiableError,
} from "@/lib/storage/errors";
import { LocalStorage } from "@/lib/storage/local-storage";
import { S3Storage } from "@/lib/storage/s3-storage";

vi.mock("@/lib/env", () => ({ env: {} }));

const key = "recording.ogg";
const range = { start: BigInt(2), end: BigInt(5) };

async function expectRead(
    opened: Awaited<ReturnType<LocalStorage["openRead"]>>,
    totalSize: number,
    start: number,
    end: number,
    bytes: string,
) {
    expect(opened.totalSize).toBe(totalSize);
    expect(opened.range).toEqual({ start, end });
    expect(await new Response(opened.body).text()).toBe(bytes);
}

describe("local storage ranged reads", () => {
    let directory: string;
    let storage: LocalStorage;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "audio-range-"));
        storage = new LocalStorage(directory);
    });

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    it.each([
        "012",
        "0123456789abcdef",
    ])("aborts an opened suffix read on atomic replacement of %s", async (original) => {
        await writeFile(join(directory, key), original);
        const opened = await storage.openRead(key, { suffixLength: BigInt(2) });
        await writeFile(join(directory, "replacement"), "abcdefghij");
        await rename(join(directory, "replacement"), join(directory, key));

        expect(opened.totalSize).toBe(original.length);
        expect(opened.range).toEqual({
            start: original.length - 2,
            end: original.length - 1,
        });
        await expect(new Response(opened.body).text()).rejects.toBeInstanceOf(
            StorageObjectChangedError,
        );
    });

    it("aborts an opened read when the file is unlinked", async () => {
        const path = join(directory, key);
        await writeFile(path, "0123456789");
        const { body } = await storage.openRead(key, range);
        await unlink(path);

        await expect(new Response(body).text()).rejects.toBeInstanceOf(
            StorageObjectChangedError,
        );
    });

    it.each([
        "uploadFile",
        "uploadStream",
        "copyFile",
    ] as const)("aborts an in-progress read when %s overwrites the inode", async (writer) => {
        const original = Buffer.alloc(1024 * 1024, "a");
        const replacement = Buffer.alloc(original.length, "b");
        await storage.uploadFile(key, original, "audio/ogg");
        const path = join(directory, key);
        await chmod(path, 0o600);
        const before = await stat(path, { bigint: true });
        const { body } = await storage.openRead(key, null);
        const reader = body.getReader();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const error = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
            const first = await reader.read();
            expect(first.done).toBe(false);
            expect(first.value).toEqual(original.subarray(0, 64 * 1024));

            if (writer === "uploadFile") {
                await storage.uploadFile(key, replacement, "audio/ogg");
            } else if (writer === "uploadStream") {
                await storage.uploadStream(
                    key,
                    Readable.from([replacement]),
                    "audio/ogg",
                );
            } else {
                await storage.uploadFile(
                    "source.ogg",
                    replacement,
                    "audio/ogg",
                );
                await chmod(join(directory, "source.ogg"), 0o600);
                await storage.copyFile("source.ogg", key);
            }

            await expect(reader.read()).rejects.toMatchObject({
                name: "StorageObjectChangedError",
            });
            const after = await stat(path, { bigint: true });
            expect(after.ino).toBe(before.ino);
            expect(Number(after.mode) & 0o777).toBe(0o600);
            expect((await storage.downloadFile(key)).equals(replacement)).toBe(
                true,
            );
            expect(warn).toHaveBeenCalledExactlyOnceWith(
                "[storage] Audio stream failed",
                "StorageObjectChangedError",
                "Storage object changed during the read",
            );
            expect(error).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
            error.mockRestore();
            await reader.cancel().catch(() => {});
        }
    });

    it.each([
        ["with the original path", false],
        ["followed by atomic replacement", true],
    ] as const)("detects a same-size overwrite with restored mtime %s", async (_description, replace) => {
        const path = join(directory, key);
        await storage.uploadFile(
            key,
            Buffer.alloc(128 * 1024, "a"),
            "audio/ogg",
        );
        const time = new Date("2026-01-01T00:00:00.000Z");
        await utimes(path, time, time);
        const handle = await open(path, "r");
        const before = await handle.stat({ bigint: true });
        const opened = await storage.openRead(key, {
            start: BigInt(0),
            end: null,
        });
        const reader = opened.body.getReader();
        try {
            const first = await reader.read();
            expect(first.value).toEqual(Buffer.alloc(64 * 1024, "a"));
            await storage.uploadFile(
                key,
                Buffer.alloc(128 * 1024, "b"),
                "audio/ogg",
            );
            await utimes(path, time, time);
            if (replace) {
                const replacement = join(directory, "replacement");
                await writeFile(replacement, Buffer.alloc(128 * 1024, "a"));
                await rename(replacement, path);
            }
            const after = await handle.stat({ bigint: true });
            expect(after.size).toBe(before.size);
            expect(after.mtimeNs).toBe(before.mtimeNs);
            expect(after.ctimeNs).not.toBe(before.ctimeNs);
            if (replace) expect(after.nlink).toBeLessThan(before.nlink);
            const failure = await reader.read().then(
                () => undefined,
                (error: unknown) => error,
            );
            expect(failure).toBeInstanceOf(StorageObjectChangedError);
        } finally {
            await reader.cancel().catch(() => {});
            await handle.close();
        }
    });

    it("gets the file size and reads only the inclusive range", async () => {
        await writeFile(join(directory, key), "0123456789");

        expect(await storage.getObjectSize(key)).toBe(10);
        await expectRead(await storage.openRead(key, range), 10, 2, 5, "2345");
        expect(await text(await storage.downloadStream(key))).toBe(
            "0123456789",
        );
    });

    it("streams the entire open-ended interval past the first 2 MiB", async () => {
        const MiB = 1024 * 1024;
        const data = Buffer.alloc(5 * MiB);
        data[MiB] = 0x12;
        data[3 * MiB] = 0x34;
        data[data.length - 1] = 0x56;
        await writeFile(join(directory, key), data);
        const opened = await storage.openRead(key, {
            start: BigInt(MiB),
            end: null,
        });

        expect(opened.range).toEqual({ start: MiB, end: data.length - 1 });
        const bytes = Buffer.from(
            await new Response(opened.body).arrayBuffer(),
        );
        expect(bytes.equals(data.subarray(MiB))).toBe(true);
    });

    it("clamps the read to the size of the opened file", async () => {
        await writeFile(join(directory, key), "0123456789");
        expect(await storage.getObjectSize(key)).toBe(10);
        await writeFile(join(directory, key), "0123");

        await expectRead(await storage.openRead(key, range), 4, 2, 3, "23");
        const unsatisfied = storage.openRead(key, {
            start: BigInt(4),
            end: BigInt(5),
        });
        await expect(unsatisfied).rejects.toBeInstanceOf(
            StorageRangeNotSatisfiableError,
        );
        await expect(unsatisfied).rejects.toMatchObject({ totalSize: 4 });
    });

    it("rejects both operations for a missing object", async () => {
        await expect(storage.getObjectSize(key)).rejects.toBeInstanceOf(
            StorageObjectMissingError,
        );
        await expect(storage.openRead(key, range)).rejects.toBeInstanceOf(
            StorageObjectMissingError,
        );
        await expect(storage.downloadFile(key)).rejects.toBeInstanceOf(
            StorageObjectMissingError,
        );
    });

    it("applies the existing key validation to both operations", async () => {
        await expect(storage.getObjectSize("../recording.ogg")).rejects.toThrow(
            "Invalid file key",
        );
        await expect(
            storage.openRead("../recording.ogg", range),
        ).rejects.toThrow("Invalid file key");
    });
});

describe("S3 storage ranged reads", () => {
    const client: {
        send(
            command: HeadObjectCommand | GetObjectCommand,
            options?: { abortSignal?: AbortSignal },
        ): Promise<unknown>;
    } = S3Client.prototype;
    const storage = new S3Storage({
        bucket: "recordings",
        region: "us-east-1",
        accessKeyId: "test-key",
        secretAccessKey: "test-secret",
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each([
        ["012", "bytes 1-2/3", 1],
        ["0123456789abcdef", "bytes 14-15/16", 14],
    ])("sends a native suffix for the current S3 object %s", async (object, contentRange, start) => {
        const body = Readable.from([Buffer.from(object.slice(-2))]);
        const send = vi.spyOn(client, "send").mockResolvedValue({
            Body: body,
            ContentRange: contentRange,
        });
        const opened = await storage.openRead(key, { suffixLength: BigInt(2) });

        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0].input).toMatchObject({
            Range: "bytes=-2",
        });
        expect(opened.range).toEqual({ start, end: start + 1 });
        expect(opened.totalSize).toBe(object.length);
        expect(await new Response(opened.body).text()).toBe(object.slice(-2));
        expect(body.destroyed).toBe(true);
    });

    it("destroys a body that arrives after the request has already aborted", async () => {
        const controller = new AbortController();
        const body = new Readable({ read() {} });
        const result = Promise.withResolvers<unknown>();
        const send = vi.spyOn(client, "send").mockReturnValue(result.promise);
        const opened = storage.openRead(key, null, controller.signal);
        expect(send.mock.calls[0][1]?.abortSignal).toBe(controller.signal);
        controller.abort();
        result.resolve({ Body: body, ContentLength: 10 });

        await expect(opened).rejects.toBe(controller.signal.reason);
        expect(send).toHaveBeenCalledTimes(1);
        expect(body.destroyed).toBe(true);
    });

    it("destroys an opened body when the request aborts without ever consuming it", async () => {
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        const controller = new AbortController();
        const read = vi.fn();
        const body = new Readable({ read });
        vi.spyOn(client, "send").mockResolvedValue({
            Body: body,
            ContentLength: 10,
        });
        const opened = await storage.openRead(key, null, controller.signal);

        controller.abort();
        expect(body.destroyed).toBe(true);
        expect(read).not.toHaveBeenCalled();
        await expect(opened.body.getReader().read()).rejects.toBe(
            controller.signal.reason,
        );
        expect(log).not.toHaveBeenCalled();
    });

    it("cancels a pending pull and destroys the S3 body without a request abort", async () => {
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        const reading = Promise.withResolvers<void>();
        const body = new Readable({ read: () => reading.resolve() });
        vi.spyOn(client, "send").mockResolvedValue({
            Body: body,
            ContentLength: 10,
        });
        const opened = await storage.openRead(key, null);
        const reader = opened.body.getReader();
        const pending = reader.read();
        await reading.promise;

        await reader.cancel();
        expect(body.destroyed).toBe(true);
        await expect(pending).resolves.toMatchObject({ done: true });
        expect(log).not.toHaveBeenCalled();
    });

    it("destroys a failed S3 source and propagates the error before the first pull", async () => {
        const failure = new Error("source failed");
        const body = new Readable({ read() {} });
        vi.spyOn(client, "send").mockResolvedValue({
            Body: body,
            ContentLength: 10,
        });
        const opened = await storage.openRead(key, null);
        body.emit("error", failure);

        expect(body.destroyed).toBe(true);
        await expect(opened.body.getReader().read()).rejects.toThrow(
            "Could not read the storage body",
        );
    });

    it("looks up size using HeadObject", async () => {
        const send = vi
            .spyOn(client, "send")
            .mockResolvedValue({ ContentLength: 10 });

        expect(await storage.getObjectSize(key)).toBe(10);
        const [command] = send.mock.calls[0];
        expect(command).toBeInstanceOf(HeadObjectCommand);
        expect(command.input).toEqual({ Bucket: "recordings", Key: key });
        expect(send).toHaveBeenCalledTimes(1);
    });

    it("sends the byte range with GetObject and uses that response's size", async () => {
        const body = Readable.from([Buffer.from("2"), Buffer.from("3")]);
        const send = vi.spyOn(client, "send").mockResolvedValue({
            Body: body,
            ContentRange: "bytes 2-3/4",
        });

        await expectRead(await storage.openRead(key, range), 4, 2, 3, "23");
        const [command] = send.mock.calls[0];
        expect(command).toBeInstanceOf(GetObjectCommand);
        expect(command.input).toEqual({
            Bucket: "recordings",
            Key: key,
            Range: "bytes=2-5",
        });
        expect(body.destroyed).toBe(true);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it("closes the body before asking HEAD when S3 ignores a satisfiable range", async () => {
        const body = Readable.from([Buffer.from("0123456789")]);
        const send = vi
            .spyOn(client, "send")
            .mockResolvedValueOnce({ Body: body })
            .mockImplementationOnce(async (command) => {
                expect(command).toBeInstanceOf(HeadObjectCommand);
                expect(body.destroyed).toBe(true);
                return { ContentLength: 10 };
            });

        await expect(storage.openRead(key, range)).rejects.toThrow(
            "Content-Range",
        );
        expect(send).toHaveBeenCalledTimes(2);
    });

    it("destroys a Range-ignoring 200 body when its size makes the range unsatisfiable", async () => {
        const body = new Readable({ read() {} });
        const send = vi
            .spyOn(client, "send")
            .mockResolvedValueOnce({
                $metadata: { httpStatusCode: 200 },
                Body: body,
                ContentLength: 100,
            })
            .mockResolvedValueOnce({ ContentLength: 10 });

        const read = storage.openRead(key, { start: BigInt(20), end: null });
        await expect(read).rejects.toBeInstanceOf(
            StorageRangeNotSatisfiableError,
        );
        await expect(read).rejects.toMatchObject({ totalSize: 10 });
        expect(body.destroyed).toBe(true);
        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[1][0]).toBeInstanceOf(HeadObjectCommand);
    });

    it("logs a stream error once without exposing the backend message", async () => {
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const failure = new Error("read failed for private/path/recording.ogg");
        const body = new Readable({
            read() {
                this.destroy(failure);
            },
        });
        vi.spyOn(client, "send").mockResolvedValue({
            Body: body,
            ContentLength: 10,
        });
        const opened = await storage.openRead(key, null);

        await expect(new Response(opened.body).text()).rejects.toThrow(
            "Could not read the storage body",
        );
        expect(body.destroyed).toBe(true);
        expect(log).toHaveBeenCalledExactlyOnceWith(
            "[storage] Audio stream failed",
            "Error",
            "Could not read the storage body",
        );
        expect(warn).not.toHaveBeenCalled();
    });

    it.each([
        ["ranged GET", range, "2", { ContentRange: "bytes 2-3/4" }],
        ["full GET", null, "12", { ContentLength: 4 }],
    ] as const)("rejects a short S3 body for %s", async (_description, requested, payload, metadata) => {
        const body = Readable.from([Buffer.from(payload)]);
        vi.spyOn(client, "send").mockResolvedValue({ Body: body, ...metadata });

        const opened = await storage.openRead(key, requested);
        await expect(new Response(opened.body).text()).rejects.toThrow(
            "Storage body ended before the promised length",
        );
        expect(body.destroyed).toBe(true);
    });

    it("rejects a body that exceeds the returned range", async () => {
        const body = Readable.from([Buffer.from("234")]);
        vi.spyOn(client, "send").mockResolvedValue({
            Body: body,
            ContentRange: "bytes 2-3/4",
        });

        const opened = await storage.openRead(key, range);
        await expect(new Response(opened.body).text()).rejects.toThrow(
            "exceeds the promised length",
        );
        expect(body.destroyed).toBe(true);
    });

    it("rejects an advertised 206 that covers less than the requested interval", async () => {
        const body = Readable.from([Buffer.from("23")]);
        vi.spyOn(client, "send").mockResolvedValue({
            Body: body,
            ContentRange: "bytes 2-3/10",
        });

        await expect(storage.openRead(key, range)).rejects.toThrow(
            "invalid Content-Range",
        );
        expect(body.destroyed).toBe(true);
    });

    it("streams a full GET using only its own ContentLength", async () => {
        const read = vi.fn(function (this: Readable) {
            this.push("0123");
            this.push(null);
        });
        const body = new Readable({ read });
        const send = vi.spyOn(client, "send").mockResolvedValue({
            Body: body,
            ContentLength: 4,
        });
        const opened = await storage.openRead(key, null);

        expect(opened.totalSize).toBe(4);
        expect(opened.range).toBeNull();
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
        expect(send.mock.calls[0][0].input.Range).toBeUndefined();
        expect(read).not.toHaveBeenCalled();
        expect(await new Response(opened.body).text()).toBe("0123");
        expect(body.destroyed).toBe(true);
    });

    it("omits Range for a full stream", async () => {
        const body = Readable.from([Buffer.from("0123456789")]);
        const send = vi.spyOn(client, "send").mockResolvedValue({ Body: body });

        expect(await text(await storage.downloadStream(key))).toBe(
            "0123456789",
        );
        const [command] = send.mock.calls[0];
        expect(command).toBeInstanceOf(GetObjectCommand);
        expect(command.input).toEqual({ Bucket: "recordings", Key: key });
    });

    it("confirms a missing object with a one-byte GET after a bare HEAD 404", async () => {
        const missingKey = new NoSuchKey({
            message: "No such key",
            $metadata: { httpStatusCode: 404 },
        });
        const send = vi
            .spyOn(client, "send")
            .mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
            .mockRejectedValueOnce(missingKey);

        await expect(storage.getObjectSize(key)).rejects.toBeInstanceOf(
            StorageObjectMissingError,
        );
        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
        expect(send.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand);
        expect(send.mock.calls[1][0].input).toEqual({
            Bucket: "recordings",
            Key: key,
            Range: "bytes=0-0",
        });
    });

    it.each([
        "NoSuchBucket",
        "AccessDenied",
        "NotFound",
    ])("preserves %s from the HEAD probe", async (name) => {
        const failure = Object.assign(new Error(name), { name });
        const send = vi
            .spyOn(client, "send")
            .mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
            .mockRejectedValueOnce(failure);

        await expect(storage.getObjectSize(key)).rejects.toBe(failure);
        expect(send).toHaveBeenCalledTimes(2);
    });

    it("closes a successful probe and preserves the original HEAD error", async () => {
        const failure = { $metadata: { httpStatusCode: 404 } };
        const body = Readable.from([Buffer.from("0")]);
        const send = vi
            .spyOn(client, "send")
            .mockRejectedValueOnce(failure)
            .mockResolvedValueOnce({ Body: body });

        await expect(storage.getObjectSize(key)).rejects.toBe(failure);
        expect(body.destroyed).toBe(true);
        expect(send).toHaveBeenCalledTimes(2);
    });

    it.each([
        "downloadFile",
        "openRead",
    ] as const)("normalizes NoSuchKey from %s", async (method) => {
        vi.spyOn(client, "send").mockRejectedValue(
            new NoSuchKey({
                message: "No such key",
                $metadata: { httpStatusCode: 404 },
            }),
        );

        const read =
            method === "downloadFile"
                ? storage.downloadFile(key)
                : storage.openRead(key, range);
        await expect(read).rejects.toBeInstanceOf(StorageObjectMissingError);
    });

    it("reports the current size when S3 rejects an outdated range", async () => {
        vi.spyOn(client, "send")
            .mockRejectedValueOnce({
                name: "InvalidRange",
                $metadata: { httpStatusCode: 416 },
            })
            .mockResolvedValueOnce({ ContentLength: 1 });

        const unsatisfied = storage.openRead(key, range);
        await expect(unsatisfied).rejects.toBeInstanceOf(
            StorageRangeNotSatisfiableError,
        );
        await expect(unsatisfied).rejects.toMatchObject({ totalSize: 1 });
    });

    it.each([
        "satisfiable",
        "HEAD fails",
    ])("keeps the sanitized ranged GET failure when the fallback is %s", async (mode) => {
        const failure = Object.assign(new Error(`Cannot read ${key}`), {
            name: "InvalidObjectState",
            $metadata: { httpStatusCode: 403 },
        });
        const send = vi.spyOn(client, "send").mockRejectedValueOnce(failure);
        if (mode === "satisfiable") {
            send.mockResolvedValueOnce({ ContentLength: 10 });
        } else {
            send.mockRejectedValueOnce(
                new NoSuchKey({
                    message: "No such key",
                    $metadata: { httpStatusCode: 404 },
                }),
            );
        }

        const read = storage.openRead(key, range);
        await expect(read).rejects.toMatchObject({
            name: "Error",
            message:
                "Failed to download file from S3 (InvalidObjectState, HTTP 403)",
        });
        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[1][0]).toBeInstanceOf(HeadObjectCommand);
    });

    it("keeps a non-abort GET failure when the request disconnects at the same time", async () => {
        const controller = new AbortController();
        const send = vi
            .spyOn(client, "send")
            .mockImplementationOnce(async () => {
                controller.abort();
                throw new Error("S3 GET failed");
            });

        await expect(
            storage.openRead(key, range, controller.signal),
        ).rejects.toMatchObject({
            name: "Error",
            message: "Failed to download file from S3 (Error)",
        });
        expect(send).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["an invalid code", `AccessDenied: ${key}`, 403, "HTTP 403"],
        ["an invalid HTTP status", "AccessDenied", key, "AccessDenied"],
    ] as const)("excludes %s from S3 read diagnostics", async (_description, name, status, safeDetail) => {
        vi.spyOn(client, "send").mockRejectedValueOnce({
            name,
            $metadata: { httpStatusCode: status },
        });
        await expect(storage.openRead(key, null)).rejects.toMatchObject({
            name: "Error",
            message: `Failed to download file from S3 (${safeDetail})`,
        });
    });

    it("cancels the metadata lookup after S3 omits the size from a 416", async () => {
        const controller = new AbortController();
        const started = Promise.withResolvers<void>();
        const send = vi
            .spyOn(client, "send")
            .mockRejectedValueOnce({ $metadata: { httpStatusCode: 416 } })
            .mockImplementationOnce(
                (_command, options) =>
                    new Promise((_resolve, reject) => {
                        options?.abortSignal?.addEventListener("abort", () =>
                            reject(controller.signal.reason),
                        );
                        started.resolve();
                    }),
            );
        const opened = storage.openRead(key, range, controller.signal);
        await started.promise;
        controller.abort();

        expect(send.mock.calls[1][0]).toBeInstanceOf(HeadObjectCommand);
        expect(send.mock.calls[1][1]?.abortSignal).toBe(controller.signal);
        await expect(opened).rejects.toBe(controller.signal.reason);
        expect(send).toHaveBeenCalledTimes(2);
    });

    it.each([
        { $response: { headers: { "content-range": "bytes */12" } } },
        { ActualObjectSize: "12" },
    ])("uses the 416 response's own size when available", async (size) => {
        const send = vi.spyOn(client, "send").mockRejectedValueOnce({
            ...size,
            name: "InvalidRange",
            $metadata: { httpStatusCode: 416 },
        });

        await expect(
            storage.openRead(key, { start: BigInt(12), end: null }),
        ).rejects.toMatchObject({ totalSize: 12 });
        expect(send).toHaveBeenCalledTimes(1);
    });

    it("answers a positive suffix of an empty S3 object with an empty full body", async () => {
        vi.spyOn(client, "send").mockRejectedValueOnce({
            ActualObjectSize: "0",
            name: "InvalidRange",
            $metadata: { httpStatusCode: 416 },
        });
        const opened = await storage.openRead(key, { suffixLength: BigInt(5) });
        expect(opened.totalSize).toBe(0);
        expect(opened.range).toBeNull();
        expect(await new Response(opened.body).text()).toBe("");
    });
});
