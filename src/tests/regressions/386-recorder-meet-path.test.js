import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractMeetCode } from "@/lib/integrations/google/meet-code";
import { matchAgendas } from "../../../extensions/recorder/lib/agendas.js";
import { meetCode } from "../../../extensions/recorder/lib/meet-code.js";
import {
    meetingTarget,
    sameMeetingTarget,
} from "../../../extensions/recorder/lib/meeting-target.js";
import {
    meetingRoom,
    roomIsOpen,
} from "../../../extensions/recorder/lib/next-meeting.js";
import {
    detectMeetingPlatform,
    PLATFORMS,
} from "../../../extensions/recorder/lib/platforms.js";

const request = vi.hoisted(() => vi.fn());
vi.mock("../../../extensions/recorder/lib/pairing-request-auth.js", () => ({
    pairingRequest: request,
}));

beforeEach(() => {
    vi.stubGlobal("chrome", {
        storage: {
            local: {
                get: async () => ({
                    serverUrl: "https://example.com",
                    encryptedApiKey: { nonce: [1] },
                    dataUseAcknowledgedAt: "now",
                    serverDefaults: { agendas: true },
                }),
            },
        },
    });
    request.mockReset().mockResolvedValue({
        json: async () => ({
            data: [{ id: "agenda", start: new Date().toISOString() }],
        }),
    });
});
afterEach(() => vi.unstubAllGlobals());

describe("#386 Meet redirect paths share one room identity", () => {
    it.each(
        ["", "meet/"].flatMap((prefix) =>
            [
                "",
                "/",
                "?authuser=test%40example.com#joined",
                "/?authuser=1#joined",
            ].map(
                (suffix) =>
                    `https://meet.google.com/${prefix}ABC-defg-HIJ${suffix}`,
            ),
        ),
    )("recognizes %s in every parser", async (url) => {
        expect(meetCode(url)).toBe("abc-defg-hij");
        expect(PLATFORMS[0].inMeeting(new URL(url))).toBe(true);
        expect(detectMeetingPlatform(url)?.id).toBe("google-meet");
        expect(meetingRoom(url)).toBe("/abc-defg-hij");
        expect(
            roomIsOpen({ joinUrl: "https://meet.google.com/abc-defg-hij" }, [
                { url },
            ]),
        ).toBe(true);
        expect(meetingTarget(url)?.meetingId).toBe("abc-defg-hij");
        expect(
            sameMeetingTarget(url, "https://meet.google.com/abc-defg-hij"),
        ).toBe(true);
        expect(extractMeetCode({ hangoutLink: url })).toBe("abc-defg-hij");
        expect(
            extractMeetCode({
                conferenceData: {
                    entryPoints: [{ entryPointType: "video", uri: url }],
                },
            }),
        ).toBe("abc-defg-hij");
        expect(await matchAgendas(url)).toHaveLength(1);
        const path = request.mock.calls[0][0];
        expect(
            new URL(path, "https://example.com").searchParams.get("meetCode"),
        ).toBe("abc-defg-hij");
        expect(path).not.toMatch(/authuser|example.com|joined|meet.google/);
    });
    it.each([
        "https://meet.google.com/",
        "https://meet.google.com/meet/",
        "https://meet.google.com/meet/abc-defg-hij/extra",
        "https://meet.google.com.evil.example/abc-defg-hij",
        "https://other.meet.google.com/abc-defg-hij",
        "http://meet.google.com/abc-defg-hij",
        "https://user@meet.google.com/abc-defg-hij",
        "https://meet.google.com:8443/abc-defg-hij",
        "invalid",
    ])("rejects non-room URL %s", (url) => {
        expect(meetCode(url)).toBeNull();
        expect(detectMeetingPlatform(url)).toBeNull();
        expect(meetingRoom(url)).toBeNull();
        expect(meetingTarget(url)?.meetingId ?? null).toBeNull();
        expect(extractMeetCode({ hangoutLink: url })).toBeNull();
    });
});
