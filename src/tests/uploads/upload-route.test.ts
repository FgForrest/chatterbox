/**
 * `POST /api/recordings/upload` takes the file as the raw request body and
 * streams videos straight to storage. The size limit is judged from the
 * declared size before a byte is read, and a body that breaks its declared
 * size must leave nothing behind in storage.
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv, storageDir } = vi.hoisted(() => ({
    mockEnv: {
        VIDEO_UPLOAD_MAX_BYTES: 1024,
        ADMIN_HOSTNAME: undefined as string | undefined,
    },
    storageDir: { path: "" },
}));

vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));
vi.mock("@/lib/org/config", () => ({
    assertNotOrgAccount: async () => {},
}));
vi.mock("@/lib/entitlements", () => ({
    isHostedLockedOut: async () => false,
}));
vi.mock("@/lib/hosted/billing/storage-cap", () => ({
    enforceStorageCap: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/encryption/fields", () => ({
    encryptText: (value: string) => `enc:${value}`,
    decryptText: (value: string) => value.replace(/^enc:/, ""),
}));
vi.mock("@/db/queries/async-jobs", () => ({
    listJobsForUser: vi.fn(async () => []),
    enqueueJob: vi.fn(),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/uploads/video-extraction-job", async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import("@/lib/uploads/video-extraction-job")
        >();
    return { ...actual, enqueueVideoExtractionJob: vi.fn() };
});
vi.mock("@/lib/uploads/save-uploaded-audio", () => ({
    saveUploadedAudio: vi.fn(async () => ({})),
}));
vi.mock("@/lib/storage/factory", async () => {
    const { LocalStorage } = await import("@/lib/storage/local-storage");
    return {
        createUserStorageProvider: async () =>
            new LocalStorage(storageDir.path),
    };
});

import { GET, POST } from "@/app/api/recordings/upload/route";
import { listJobsForUser } from "@/db/queries/async-jobs";
import { enforceStorageCap } from "@/lib/hosted/billing/storage-cap";
import { saveUploadedAudio } from "@/lib/uploads/save-uploaded-audio";
import { enqueueVideoExtractionJob } from "@/lib/uploads/video-extraction-job";

interface UploadOptions {
    filename: string;
    type?: string;
    /** What the client claims; defaults to the real body length. */
    declaredSize?: number;
    host?: string;
}

/** A body that records whether the route ever pulled from it. */
function trackedBody(bytes: Uint8Array) {
    const tracker = { read: false };
    const stream = new ReadableStream<Uint8Array>(
        {
            pull(controller) {
                tracker.read = true;
                // Split so the limit is crossed mid-stream, not on the first chunk.
                const middle = Math.floor(bytes.length / 2);
                controller.enqueue(bytes.slice(0, middle));
                controller.enqueue(bytes.slice(middle));
                controller.close();
            },
        },
        // Pull only on demand, so `read` means the route asked for bytes.
        { highWaterMark: 0 },
    );
    return { stream, tracker };
}

function uploadRequest(bytes: Uint8Array, options: UploadOptions) {
    const { stream, tracker } = trackedBody(bytes);
    const headers: Record<string, string> = {
        host: options.host ?? "app.example.test",
        "x-upload-filename": encodeURIComponent(options.filename),
        "x-upload-size": String(options.declaredSize ?? bytes.length),
    };
    if (options.type) headers["content-type"] = options.type;
    const request = new Request(
        "http://app.example.test/api/recordings/upload",
        {
            method: "POST",
            headers,
            body: stream,
            duplex: "half",
        } as RequestInit,
    );
    return { request, tracker };
}

async function storedFiles(): Promise<string[]> {
    try {
        return await readdir(
            path.join(storageDir.path, "user-1/video-uploads"),
        );
    } catch {
        return [];
    }
}

const video = new Uint8Array(600).map((_, index) => index % 251);

beforeEach(async () => {
    storageDir.path = await mkdtemp(path.join(tmpdir(), "riffado-upload-"));
    mockEnv.VIDEO_UPLOAD_MAX_BYTES = 1024;
    mockEnv.ADMIN_HOSTNAME = undefined;
    vi.mocked(listJobsForUser).mockResolvedValue([]);
    vi.mocked(enqueueVideoExtractionJob).mockReset();
    vi.mocked(enqueueVideoExtractionJob).mockResolvedValue({
        created: true,
        job: { id: "job-1" },
    } as Awaited<ReturnType<typeof enqueueVideoExtractionJob>>);
    vi.mocked(saveUploadedAudio).mockClear();
    vi.mocked(enforceStorageCap).mockClear();
});

afterEach(async () => {
    await rm(storageDir.path, { recursive: true, force: true });
});

describe("POST /api/recordings/upload", () => {
    it("streams a video to storage and queues its extraction", async () => {
        const { request } = uploadRequest(video, {
            filename: "Team sync.mkv",
            type: "video/x-matroska",
        });

        const response = await POST(request);

        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({
            success: true,
            filename: "Team sync",
            conversion: true,
            jobId: "job-1",
        });
        const [stored] = await storedFiles();
        expect(stored).toBeDefined();
        const saved = await readFile(
            path.join(storageDir.path, "user-1/video-uploads", stored ?? ""),
        );
        expect(new Uint8Array(saved)).toEqual(video);
        expect(enqueueVideoExtractionJob).toHaveBeenCalledWith(
            expect.objectContaining({
                sourceStorageKey: `user-1/video-uploads/${stored}`,
                encryptedFilename: "enc:Team sync.mkv",
                sourceSize: video.length,
                userId: "user-1",
            }),
        );
        expect(enforceStorageCap).toHaveBeenCalledWith({
            userId: "user-1",
            additionalBytes: video.length,
        });
    });

    it("refuses a video over the configured limit without reading it", async () => {
        mockEnv.VIDEO_UPLOAD_MAX_BYTES = 500;
        const { request, tracker } = uploadRequest(video, {
            filename: "long.mp4",
            type: "video/mp4",
        });

        const response = await POST(request);

        expect(response.status).toBe(413);
        expect((await response.json()).code).toBe("FILE_TOO_LARGE");
        expect(tracker.read).toBe(false);
        expect(await storedFiles()).toEqual([]);
    });

    it("keeps the 500 MB cap on audio, which is read into memory", async () => {
        const { request, tracker } = uploadRequest(video, {
            filename: "voice.wav",
            type: "audio/wav",
            declaredSize: 500 * 1024 * 1024 + 1,
        });

        const response = await POST(request);

        expect(response.status).toBe(413);
        expect((await response.json()).error).toBe(
            "File exceeds the 500 MB size limit",
        );
        expect(tracker.read).toBe(false);
    });

    it("hands a small audio file to the audio pipeline whole", async () => {
        const { request } = uploadRequest(video, {
            filename: "voice.m4a",
            type: "audio/mp4",
        });

        const response = await POST(request);

        expect(response.status).toBe(200);
        expect(saveUploadedAudio).toHaveBeenCalledTimes(1);
        const input = vi.mocked(saveUploadedAudio).mock.calls[0]?.[0];
        if (!input) throw new Error("saveUploadedAudio was not called");
        expect(new Uint8Array(input.buffer)).toEqual(video);
        expect(input.basename).toBe("voice");
        expect(input.extension).toBe(".m4a");
    });

    it("drops the stored part of a video that outgrows its declared size", async () => {
        const { request } = uploadRequest(video, {
            filename: "meeting.mov",
            type: "video/quicktime",
            declaredSize: 400,
        });

        const response = await POST(request);

        expect(response.status).toBe(400);
        expect((await response.json()).code).toBe("INVALID_INPUT");
        expect(await storedFiles()).toEqual([]);
        expect(enqueueVideoExtractionJob).not.toHaveBeenCalled();
    });

    it("drops the stored part of a video that ends early", async () => {
        const { request } = uploadRequest(video, {
            filename: "meeting.mov",
            type: "video/quicktime",
            declaredSize: 900,
        });

        const response = await POST(request);

        expect(response.status).toBe(400);
        expect((await response.json()).error).toMatch(/interrupted/);
        expect(await storedFiles()).toEqual([]);
        expect(enqueueVideoExtractionJob).not.toHaveBeenCalled();
    });

    it("turns a second video away before it is sent, not after", async () => {
        vi.mocked(listJobsForUser).mockResolvedValue([
            { id: "busy" },
        ] as Awaited<ReturnType<typeof listJobsForUser>>);
        const { request, tracker } = uploadRequest(video, {
            filename: "second.mp4",
            type: "video/mp4",
        });

        const response = await POST(request);

        expect(response.status).toBe(429);
        expect(tracker.read).toBe(false);
        expect(await storedFiles()).toEqual([]);
    });

    it("refuses the old multipart form with a hint to reload", async () => {
        const { request } = uploadRequest(video, {
            filename: "meeting.mp4",
            type: "multipart/form-data; boundary=x",
        });

        const response = await POST(request);

        expect(response.status).toBe(415);
    });

    it("refuses an upload that does not state its size", async () => {
        const { request } = uploadRequest(video, {
            filename: "meeting.mp4",
            type: "video/mp4",
        });
        request.headers.delete("x-upload-size");

        const response = await POST(request);

        expect(response.status).toBe(411);
    });

    it("keeps the admin-host gate the proxy no longer applies", async () => {
        mockEnv.ADMIN_HOSTNAME = "admin.example.test";
        const { request, tracker } = uploadRequest(video, {
            filename: "meeting.mp4",
            type: "video/mp4",
            host: "admin.example.test",
        });

        const response = await POST(request);

        expect(response.status).toBe(404);
        expect(tracker.read).toBe(false);
    });
});

describe("GET /api/recordings/upload", () => {
    it("tells the browser the limits so it can refuse a file up front", async () => {
        mockEnv.VIDEO_UPLOAD_MAX_BYTES = 4 * 1024 ** 3;

        const response = await GET(
            new Request("http://app.example.test/api/recordings/upload", {
                headers: { host: "app.example.test" },
            }),
        );

        expect(await response.json()).toEqual({
            uploads: [],
            limits: {
                audioMaxBytes: 500 * 1024 * 1024,
                videoMaxBytes: 4 * 1024 ** 3,
            },
        });
    });
});
