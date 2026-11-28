import { expect, it } from "vitest";
import { meetingRoom } from "../../../extensions/recorder/lib/meeting-room.js";
import { detectMeetingPlatform } from "../../../extensions/recorder/lib/platforms.js";
import fixtures from "../fixtures/meeting-room-urls.json";

it.each(fixtures.positive)("canonicalizes %s", (url, room) => {
    expect(meetingRoom(url)).toBe(room);
});

it.each(fixtures.negative)("rejects %s", (url) => {
    expect(meetingRoom(url)).toBeNull();
});

it("rejects oversized room IDs and keeps the Zoom prompt on web client rooms", () => {
    expect(meetingRoom(`https://zoom.us/j/${"1".repeat(257)}`)).toBeNull();
    expect(detectMeetingPlatform("https://zoom.us/wc/123/join")?.id).toBe(
        "zoom",
    );
    expect(detectMeetingPlatform("https://zoom.us/wc/123abc/join")).toBeNull();
    expect(detectMeetingPlatform("https://zoom.us/j/123")).toBeNull();
});
