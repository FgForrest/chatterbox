import { describe, expect, it } from "vitest";
import { extractMeetCode } from "@/lib/integrations/google/meet-code";

describe("extractMeetCode", () => {
    it("accepts a Google Calendar video entry point", () => {
        expect(
            extractMeetCode({
                conferenceData: {
                    entryPoints: [
                        {
                            entryPointType: "video",
                            uri: "https://meet.google.com/ABC-defg-HIJ?authuser=0",
                        },
                    ],
                },
            }),
        ).toBe("abc-defg-hij");
    });

    it("accepts a matching hangout link and video entry point", () => {
        expect(
            extractMeetCode({
                hangoutLink: "https://meet.google.com/abc-defg-hij",
                conferenceData: {
                    entryPoints: [
                        {
                            entryPointType: "video",
                            uri: "https://meet.google.com/abc-defg-hij/",
                        },
                    ],
                },
            }),
        ).toBe("abc-defg-hij");
    });

    it("rejects conflicting or non-Meet URLs", () => {
        expect(
            extractMeetCode({
                hangoutLink: "https://meet.google.com/abc-defg-hij",
                conferenceData: {
                    entryPoints: [
                        {
                            entryPointType: "video",
                            uri: "https://meet.google.com/xyz-abcd-efg",
                        },
                    ],
                },
            }),
        ).toBeNull();
        for (const link of [
            "https://meet.google.com.evil.example/abc-defg-hij",
            "http://meet.google.com/abc-defg-hij",
            "https://meet.google.com/abc-defg-hij/extra",
            "https://user@meet.google.com/abc-defg-hij",
        ]) {
            expect(extractMeetCode({ hangoutLink: link })).toBeNull();
        }
    });
});
