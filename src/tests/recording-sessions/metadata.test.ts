import { describe, expect, it, vi } from "vitest";

// `@/lib/errors` pulls in `@/lib/posthog-server`, which eagerly validates
// `@/lib/env`. Stub it; this file tests pure parsing, not capture.
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

import { AppError, ErrorCode } from "@/lib/errors";
import {
    buildMeetingTitle,
    normalizeMimeType,
    parseChunkIndex,
    parseCompleteRecordingSessionBody,
    parseCreateRecordingSessionBody,
    parseSha256,
    readRecordingSessionMetadata,
} from "@/lib/recording-sessions/metadata";

const SHA = "a".repeat(64);

describe("normalizeMimeType", () => {
    it("strips codec parameters and lowercases", () => {
        expect(normalizeMimeType("audio/webm;codecs=opus")).toBe("audio/webm");
        expect(normalizeMimeType("AUDIO/OGG")).toBe("audio/ogg");
    });
});

describe("parseCreateRecordingSessionBody", () => {
    const valid = {
        mimeType: "audio/webm;codecs=opus",
        channelLayout: ["microphone", "system"],
        startedAt: "2026-09-18T12:00:00.000Z",
        platformHint: "zoom",
        clientVersion: "1.0.0",
        timezoneOffsetMinutes: 120,
        noticeAcknowledgedAt: "2026-09-18T11:59:00.000Z",
    };

    it("accepts a well-formed body", () => {
        const parsed = parseCreateRecordingSessionBody(valid);
        expect(parsed.mimeType).toBe("audio/webm");
        expect(parsed.metadata.channelLayout).toEqual(["microphone", "system"]);
        expect(parsed.metadata.platformHint).toBe("zoom");
        expect(parsed.startedAt.toISOString()).toBe("2026-09-18T12:00:00.000Z");
        expect(parsed.noticeAcknowledgedAt?.toISOString()).toBe(
            "2026-09-18T11:59:00.000Z",
        );
    });

    it("rejects an unsupported container", () => {
        expect(() =>
            parseCreateRecordingSessionBody({
                ...valid,
                mimeType: "audio/mp3",
            }),
        ).toThrowError(AppError);
    });

    it("requires startedAt", () => {
        const { startedAt: _omit, ...rest } = valid;
        try {
            parseCreateRecordingSessionBody(rest);
            expect.unreachable("should have thrown");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).code).toBe(
                ErrorCode.MISSING_REQUIRED_FIELD,
            );
        }
    });

    it("rejects an empty channel layout", () => {
        expect(() =>
            parseCreateRecordingSessionBody({ ...valid, channelLayout: [] }),
        ).toThrowError(AppError);
    });

    it("rejects a non-integer timezone offset", () => {
        expect(() =>
            parseCreateRecordingSessionBody({
                ...valid,
                timezoneOffsetMinutes: 12.5,
            }),
        ).toThrowError(AppError);
    });

    it("allows notice acknowledgement to be absent", () => {
        const { noticeAcknowledgedAt: _omit, ...rest } = valid;
        const parsed = parseCreateRecordingSessionBody(rest);
        expect(parsed.noticeAcknowledgedAt).toBeNull();
    });
});

describe("parseCompleteRecordingSessionBody", () => {
    it("accepts a valid body and defaults stop reason", () => {
        const parsed = parseCompleteRecordingSessionBody({ chunkCount: 3 });
        expect(parsed.chunkCount).toBe(3);
        expect(parsed.stopReason).toBe("unknown");
        expect(parsed.endedAt).toBeInstanceOf(Date);
    });

    it("keeps a known stop reason", () => {
        const parsed = parseCompleteRecordingSessionBody({
            chunkCount: 1,
            stopReason: "tab-closed",
        });
        expect(parsed.stopReason).toBe("tab-closed");
    });

    it("rejects an unknown stop reason", () => {
        expect(() =>
            parseCompleteRecordingSessionBody({
                chunkCount: 1,
                stopReason: "exploded",
            }),
        ).toThrowError(AppError);
    });

    it("rejects a zero chunk count", () => {
        expect(() =>
            parseCompleteRecordingSessionBody({ chunkCount: 0 }),
        ).toThrowError(AppError);
    });
});

describe("parseChunkIndex", () => {
    it("parses in-range indices", () => {
        expect(parseChunkIndex("0")).toBe(0);
        expect(parseChunkIndex("42")).toBe(42);
        expect(parseChunkIndex("9999")).toBe(9999);
    });

    it("rejects out-of-range and non-numeric indices", () => {
        expect(() => parseChunkIndex("10000")).toThrowError(AppError);
        expect(() => parseChunkIndex("-1")).toThrowError(AppError);
        expect(() => parseChunkIndex("1.5")).toThrowError(AppError);
        expect(() => parseChunkIndex("abc")).toThrowError(AppError);
    });
});

describe("parseSha256", () => {
    it("accepts a 64-char hex digest and lowercases it", () => {
        expect(parseSha256("A".repeat(64))).toBe("a".repeat(64));
    });

    it("rejects a missing or malformed digest", () => {
        expect(() => parseSha256(null)).toThrowError(AppError);
        expect(() => parseSha256("xyz")).toThrowError(AppError);
        expect(() => parseSha256("a".repeat(63))).toThrowError(AppError);
    });
});

describe("buildMeetingTitle", () => {
    it("labels a known platform and formats local time", () => {
        const title = buildMeetingTitle(
            {
                channelLayout: ["microphone", "system"],
                platformHint: "zoom",
                timezoneOffsetMinutes: 120,
            },
            new Date("2026-09-18T12:30:00.000Z"),
        );
        // 12:30 UTC + 2h = 14:30 local.
        expect(title).toBe("Meeting (Zoom) 2026-09-18 14-30");
    });

    it("falls back to a plain label without a platform", () => {
        const title = buildMeetingTitle(
            { channelLayout: ["microphone"] },
            new Date("2026-09-18T09:05:00.000Z"),
        );
        expect(title).toBe("Meeting 2026-09-18 09-05");
    });
});

describe("readRecordingSessionMetadata", () => {
    it("recovers a stored shape and tolerates missing fields", () => {
        expect(
            readRecordingSessionMetadata({
                channelLayout: ["microphone", "system"],
                platformHint: "teams",
            }),
        ).toEqual({
            channelLayout: ["microphone", "system"],
            platformHint: "teams",
        });
        expect(readRecordingSessionMetadata({})).toEqual({ channelLayout: [] });
    });
});

describe("SHA fixture sanity", () => {
    it("uses a 64-char digest", () => {
        expect(SHA).toHaveLength(64);
    });
});
