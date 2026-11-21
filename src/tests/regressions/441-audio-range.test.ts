import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/recordings/[id]/audio/route";
import { db } from "@/db";
import { ErrorCode } from "@/lib/errors";
import {
    StorageObjectMissingError,
    StorageRangeNotSatisfiableError,
} from "@/lib/storage/errors";
import { createUserStorageProvider } from "@/lib/storage/factory";
import type { ByteRange } from "@/lib/storage/types";

const storage = vi.hoisted(() => ({
    downloadFile: vi.fn(),
    downloadRange: vi.fn(),
    downloadStream: vi.fn(),
    getObjectSize: vi.fn(),
}));

vi.mock("@/db", () => ({ db: { select: vi.fn() } }));
vi.mock("@/lib/pipeline/trigger", () => ({ requestAdvanceInTx: vi.fn() }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({ user: { id: "reader" } }),
}));
vi.mock("@/lib/encryption/fields", () => ({ decryptText: vi.fn() }));
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
}

function getAudio(
    range?: string,
    query = "",
    headers = new Headers(),
    method = "GET",
) {
    if (range !== undefined) headers.set("Range", range);
    return GET(
        new Request(`http://localhost/api/recordings/rec-1/audio${query}`, {
            headers,
            method,
        }),
        { params: Promise.resolve({ id: "rec-1" }) },
    );
}

describe("recording audio ranges", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        selectRecording(recording);
        storage.getObjectSize.mockResolvedValue(audio.length);
        storage.downloadFile.mockResolvedValue(audio);
        storage.downloadRange.mockImplementation(
            async (_key: string, range: ByteRange) => ({
                data: audio.subarray(range.start, range.end + 1),
                totalSize: audio.length,
            }),
        );
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
        expect(storage.getObjectSize).toHaveBeenCalledWith(storagePath);
        expect(storage.downloadRange).toHaveBeenCalledExactlyOnceWith(
            storagePath,
            { start, end },
        );
        expect(storage.downloadFile).not.toHaveBeenCalled();
    });

    it.each([
        "bytes=10-",
        "bytes=-0",
        "bytes=999999999999999999999999-",
    ])("rejects unsatisfiable %s without reading audio", async (range) => {
        const response = await getAudio(range);

        expect(response.status).toBe(416);
        expect(response.headers.get("Content-Range")).toBe("bytes */10");
        expect(response.body).toBeNull();
        expect(storage.downloadRange).not.toHaveBeenCalled();
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
        expect(storage.downloadFile).toHaveBeenCalledExactlyOnceWith(
            storagePath,
        );
        expect(storage.getObjectSize).not.toHaveBeenCalled();
        expect(storage.downloadRange).not.toHaveBeenCalled();
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
        storage.getObjectSize.mockResolvedValue(0);
        storage.downloadFile.mockResolvedValue(Buffer.alloc(0));

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
        storage.getObjectSize.mockResolvedValue(largeAudio.length);
        storage.downloadRange.mockImplementationOnce(
            async (_key: string, requested: ByteRange) => ({
                data: largeAudio.subarray(requested.start, requested.end + 1),
                totalSize: largeAudio.length,
            }),
        );

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
        expect(storage.downloadRange).toHaveBeenCalledExactlyOnceWith(
            storagePath,
            { start, end },
        );
        expect(storage.downloadFile).not.toHaveBeenCalled();
        expect(storage.downloadStream).not.toHaveBeenCalled();
    });

    it("uses bytes and size from the same read after a replacement", async () => {
        storage.downloadRange.mockResolvedValueOnce({
            data: Buffer.from("234567"),
            totalSize: 8,
        });

        const response = await getAudio("bytes=2-");

        expect(response.status).toBe(206);
        expect(storage.downloadRange).toHaveBeenCalledExactlyOnceWith(
            storagePath,
            { start: 2, end: 9 },
        );
        expect(response.headers.get("Content-Range")).toBe("bytes 2-7/8");
        expect(response.headers.get("Content-Length")).toBe("6");
        expect(await response.text()).toBe("234567");
    });

    it("returns 416 with the latest size if a replacement invalidates the range", async () => {
        storage.downloadRange.mockRejectedValueOnce(
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
        );
        expect(storage.downloadRange).not.toHaveBeenCalled();
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
        expect(storage.downloadFile).toHaveBeenCalledExactlyOnceWith(
            storagePath,
        );
        expect(storage.getObjectSize).not.toHaveBeenCalled();
        expect(storage.downloadRange).not.toHaveBeenCalled();
    });

    it.each([
        "getObjectSize",
        "downloadRange",
        "downloadFile",
    ] as const)("returns 404 when %s reports a missing object", async (operation) => {
        storage[operation].mockRejectedValueOnce(
            new StorageObjectMissingError(),
        );

        const response = await getAudio(
            operation === "downloadFile" ? undefined : "bytes=0-0",
        );

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
