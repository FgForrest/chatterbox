import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    StorageObjectMissingError,
    StorageRangeNotSatisfiableError,
} from "@/lib/storage/errors";
import { LocalStorage } from "@/lib/storage/local-storage";
import { S3Storage } from "@/lib/storage/s3-storage";

vi.mock("@/lib/env", () => ({ env: {} }));

const key = "recording.ogg";
const range = { start: 2, end: 5 };

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

    it("gets the file size and reads only the inclusive range", async () => {
        await writeFile(join(directory, key), "0123456789");

        expect(await storage.getObjectSize(key)).toBe(10);
        expect(await storage.downloadRange(key, range)).toEqual({
            data: Buffer.from("2345"),
            totalSize: 10,
        });
        expect(await text(await storage.downloadStream(key))).toBe(
            "0123456789",
        );
    });

    it("clamps the read to the size of the opened file", async () => {
        await writeFile(join(directory, key), "0123456789");
        expect(await storage.getObjectSize(key)).toBe(10);
        await writeFile(join(directory, key), "0123");

        expect(await storage.downloadRange(key, range)).toEqual({
            data: Buffer.from("23"),
            totalSize: 4,
        });
        const unsatisfied = storage.downloadRange(key, { start: 4, end: 5 });
        await expect(unsatisfied).rejects.toBeInstanceOf(
            StorageRangeNotSatisfiableError,
        );
        await expect(unsatisfied).rejects.toMatchObject({ totalSize: 4 });
    });

    it("rejects both operations for a missing object", async () => {
        await expect(storage.getObjectSize(key)).rejects.toBeInstanceOf(
            StorageObjectMissingError,
        );
        await expect(storage.downloadRange(key, range)).rejects.toBeInstanceOf(
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
            storage.downloadRange("../recording.ogg", range),
        ).rejects.toThrow("Invalid file key");
    });
});

describe("S3 storage ranged reads", () => {
    const client: {
        send(command: HeadObjectCommand | GetObjectCommand): Promise<unknown>;
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

        expect(await storage.downloadRange(key, range)).toEqual({
            data: Buffer.from("23"),
            totalSize: 4,
        });
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

    it("closes the body if S3 ignores the Range request", async () => {
        const body = Readable.from([Buffer.from("0123456789")]);
        vi.spyOn(client, "send").mockResolvedValue({ Body: body });

        await expect(storage.downloadRange(key, range)).rejects.toThrow(
            "Content-Range",
        );
        expect(body.destroyed).toBe(true);
    });

    it("rejects a body that exceeds the returned range", async () => {
        const body = Readable.from([Buffer.from("234")]);
        vi.spyOn(client, "send").mockResolvedValue({
            Body: body,
            ContentRange: "bytes 2-3/4",
        });

        await expect(storage.downloadRange(key, range)).rejects.toThrow(
            "body exceeds Content-Range",
        );
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
        "downloadRange",
    ] as const)("normalizes NoSuchKey from %s", async (method) => {
        vi.spyOn(client, "send").mockRejectedValue(
            new NoSuchKey({
                message: "No such key",
                $metadata: { httpStatusCode: 404 },
            }),
        );

        await expect(storage[method](key, range)).rejects.toBeInstanceOf(
            StorageObjectMissingError,
        );
    });

    it("reports the current size when S3 rejects an outdated range", async () => {
        vi.spyOn(client, "send")
            .mockRejectedValueOnce({
                name: "InvalidRange",
                $metadata: { httpStatusCode: 416 },
            })
            .mockResolvedValueOnce({ ContentLength: 1 });

        const unsatisfied = storage.downloadRange(key, range);
        await expect(unsatisfied).rejects.toBeInstanceOf(
            StorageRangeNotSatisfiableError,
        );
        await expect(unsatisfied).rejects.toMatchObject({ totalSize: 1 });
    });
});
