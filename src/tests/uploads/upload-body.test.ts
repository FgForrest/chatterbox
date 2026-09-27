import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
}));

import { AppError } from "@/lib/errors";
import { formatUploadLimit, uploadExtension } from "@/lib/uploads/media-types";
import {
    readUploadBody,
    readUploadMetadata,
    streamUploadBody,
} from "@/lib/uploads/upload-body";

function body(...chunks: number[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            for (const size of chunks) controller.enqueue(new Uint8Array(size));
            controller.close();
        },
    });
}

function request(headers: Record<string, string>, content = "abc"): Request {
    return new Request("http://app.test/api/recordings/upload", {
        method: "POST",
        headers,
        body: content,
    });
}

async function statusOf(run: () => unknown): Promise<number | undefined> {
    try {
        await run();
    } catch (error) {
        return error instanceof AppError ? error.statusCode : undefined;
    }
    return undefined;
}

describe("readUploadMetadata", () => {
    it("reads the name, type and declared size", () => {
        expect(
            readUploadMetadata(
                request({
                    "x-upload-filename": encodeURIComponent("Porada č. 1.mp4"),
                    "x-upload-size": "3",
                    "content-type": "video/mp4; codecs=avc1",
                }),
            ),
        ).toEqual({
            filename: "Porada č. 1.mp4",
            mimeType: "video/mp4",
            size: 3,
        });
    });

    it("falls back to Content-Length for the size", () => {
        expect(
            readUploadMetadata(
                request({
                    "x-upload-filename": "a.mp3",
                    "content-length": "3",
                }),
            ).size,
        ).toBe(3);
    });

    it("refuses what it cannot trust", async () => {
        expect(
            await statusOf(() =>
                readUploadMetadata(
                    request({
                        "x-upload-filename": "a.mp4",
                        "content-type": "multipart/form-data; boundary=x",
                    }),
                ),
            ),
        ).toBe(415);
        expect(await statusOf(() => readUploadMetadata(request({})))).toBe(400);
        expect(
            await statusOf(() =>
                readUploadMetadata(
                    request({ "x-upload-filename": "%E0%A4%A" }),
                ),
            ),
        ).toBe(400);
        expect(
            await statusOf(() =>
                readUploadMetadata(
                    request({
                        "x-upload-filename": "a.mp4",
                        "x-upload-size": "1e9",
                    }),
                ),
            ),
        ).toBe(411);
    });
});

describe("streamUploadBody", () => {
    it("passes the bytes through and counts them", async () => {
        const upload = streamUploadBody(body(3, 4), 7);
        let total = 0;
        for await (const chunk of upload.stream) total += chunk.length;
        expect(total).toBe(7);
        expect(upload.bytes).toBe(7);
        expect(upload.error).toBeNull();
    });

    it("fails as soon as the body outgrows its declared size", async () => {
        const upload = streamUploadBody(body(3, 4, 100), 5);
        await expect(async () => {
            for await (const _ of upload.stream);
        }).rejects.toThrow("larger than it said");
        expect(upload.bytes).toBe(7);
        expect(upload.error?.statusCode).toBe(400);
    });

    it("fails when the body ends short of its declared size", async () => {
        const upload = streamUploadBody(body(3), 5);
        await expect(async () => {
            for await (const _ of upload.stream);
        }).rejects.toThrow("interrupted");
    });
});

describe("readUploadBody", () => {
    it("collects a body of the declared size", async () => {
        expect((await readUploadBody(body(2, 3), 5)).length).toBe(5);
    });

    it("surfaces the size error rather than a stream error", async () => {
        await expect(readUploadBody(body(2, 3), 4)).rejects.toBeInstanceOf(
            AppError,
        );
    });
});

describe("uploadExtension", () => {
    it.each([
        "meeting.MP4",
        "archive.tar.gz",
        "noext",
        ".hidden",
        "dir.d/file",
        "trailing.",
    ])("matches path.extname for %s, lowercased", (name) => {
        expect(uploadExtension(name)).toBe(path.extname(name).toLowerCase());
    });
});

describe("formatUploadLimit", () => {
    it.each([
        [500 * 1024 * 1024, "500 MB"],
        [4 * 1024 ** 3, "4 GB"],
        [1.5 * 1024 ** 3, "1.5 GB"],
    ])("formats %d as %s", (bytes, label) => {
        expect(formatUploadLimit(bytes)).toBe(label);
    });
});
