import { describe, expect, it } from "vitest";
import {
    meetingLabel,
    sameMeetingTarget,
} from "../../../extensions/recorder/lib/meeting-target.js";

describe("recording request meeting identity", () => {
    it.each([
        [
            "https://app.zoom.us/wc/123/join?pwd=SECRET",
            "https://us02web.zoom.us/wc/123/start",
        ],
        [
            "https://meet.google.com/abc-defg-hij?authuser=0",
            "https://meet.google.com/abc-defg-hij?authuser=1#joined",
        ],
        [
            "https://app.zoom.us/wc/123456789/join?pwd=SECRET",
            "https://app.zoom.us/wc/123456789/start?pwd=SECRET&from=join",
        ],
        [
            "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?prejoin=true",
            "https://teams.microsoft.com/v2/#/l/meetup-join/19%3ameeting_abc/0?joined=true",
        ],
        [
            "https://example.com/before?token=SECRET",
            "https://example.com/after",
        ],
        [
            "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0",
            "https://teams.microsoft.com/v2/#/l/meetup-join/19:meeting_abc@thread.v2/0",
        ],
        [
            "https://teams.microsoft.com/l/meetup-join/19:meeting_abc@thread.v2/0",
            "https://teams.microsoft.com/v2/#/l/meetup-join/19%3Ameeting_abc%40thread.v2/0",
        ],
    ])("accepts navigation within the same meeting or ordinary origin: %s", (before, after) => {
        expect(sameMeetingTarget(before, after)).toBe(true);
    });
    it.each([
        [
            "https://meet.google.com/abc-defg-hij",
            "https://meet.google.com/zzz-yyyy-xxx",
        ],
        ["https://app.zoom.us/wc/123/join", "https://app.zoom.us/wc/456/start"],
        [
            "https://teams.microsoft.com/meet/123?prejoin=true",
            "https://teams.microsoft.com/meet/456",
        ],
        ["https://example.com", "https://other.example.com"],
        ["https://meet.google.com/abc-defg-hij", "https://meet.google.com/"],
        [
            "https://teams.microsoft.com/meet/19%ZZmeeting",
            "https://teams.microsoft.com/meet/19%ZZmeeting",
        ],
        [
            "https://teams.microsoft.com/meet/19:meeting_abc@thread.v2",
            "https://teams.microsoft.com/meet/19%ZZmeeting",
        ],
        [
            "https://teams.microsoft.com/meet/19%E0%A4meeting",
            "https://teams.microsoft.com/meet/19:meeting_abc@thread.v2",
        ],
    ])("rejects a different meeting or origin: %s", (before, after) => {
        expect(sameMeetingTarget(before, after)).toBe(false);
    });
    it("shows only platform, host and meeting id without passwords or tokens", () => {
        expect(
            meetingLabel(
                "https://app.zoom.us/wc/123456789/join?pwd=SECRET#token=PRIVATE",
            ),
        ).toBe("Zoom (web) · app.zoom.us · 123456789");
    });
});
