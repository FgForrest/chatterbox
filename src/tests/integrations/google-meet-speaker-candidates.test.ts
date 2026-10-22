import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/integrations/google/connection", () => ({
    getGoogleConnectionStatus: vi.fn(),
    getGoogleAccessToken: vi.fn(),
}));
vi.mock("@/lib/integrations/google/meet-context", () => ({
    getMeetParticipantContext: vi.fn(),
}));

import {
    getGoogleAccessToken,
    getGoogleConnectionStatus,
} from "@/lib/integrations/google/connection";
import { getMeetParticipantContext } from "@/lib/integrations/google/meet-context";
import { getMeetSpeakerCandidates } from "@/lib/integrations/google/meet-speaker-candidates";

const input = {
    userId: "riffado-user-1",
    event: {
        id: "event-1",
        title: "Meeting",
        start: "2026-10-08T10:00:00.000Z",
        end: "2026-10-08T11:00:00.000Z",
        attendees: [],
        meetingCode: "abc-defg-hij",
    },
    recordingStartedAt: new Date("2026-10-08T10:00:00.000Z"),
    recordingEndedAt: new Date("2026-10-08T11:00:00.000Z"),
};

describe("Meet candidates for Learn", () => {
    beforeEach(() => {
        vi.mocked(getGoogleConnectionStatus).mockReset();
        vi.mocked(getGoogleAccessToken).mockReset();
        vi.mocked(getMeetParticipantContext).mockReset();
        vi.mocked(getGoogleConnectionStatus).mockResolvedValue({
            subject: "google-user-1",
            email: "a@example.com",
            hostedDomain: null,
            status: "active",
            scopes: ["https://www.googleapis.com/auth/meetings.space.readonly"],
        });
        vi.mocked(getGoogleAccessToken).mockResolvedValue("token");
    });

    it("passes distinct attendee names as optional speaker candidates", async () => {
        vi.mocked(getMeetParticipantContext).mockResolvedValue({
            status: "available",
            conferenceRecord: "conferenceRecords/record_1",
            participants: [
                {
                    displayName: "Alice Smith",
                    source: "signed_in",
                    googleUserId: "users/1",
                },
                {
                    displayName: "alice smith",
                    source: "anonymous",
                    googleUserId: null,
                },
                { displayName: "Bob", source: "anonymous", googleUserId: null },
            ],
        });
        await expect(getMeetSpeakerCandidates(input)).resolves.toEqual([
            { name: "Alice Smith", source: "meet" },
            { name: "Bob", source: "meet" },
        ]);
        expect(getGoogleAccessToken).toHaveBeenCalledWith(
            input.userId,
            expect.objectContaining({
                expectedSubject: "google-user-1",
                requiredScope:
                    "https://www.googleapis.com/auth/meetings.space.readonly",
            }),
        );
    });

    it("returns no context without Meet consent", async () => {
        vi.mocked(getGoogleConnectionStatus).mockResolvedValue({
            subject: "google-user-1",
            email: "a@example.com",
            hostedDomain: null,
            status: "active",
            scopes: [],
        });
        await expect(getMeetSpeakerCandidates(input)).resolves.toEqual([]);
        expect(getGoogleAccessToken).not.toHaveBeenCalled();
    });

    it("counts diacritic variants once and keeps the first display form", async () => {
        vi.mocked(getMeetParticipantContext).mockResolvedValue({
            status: "available",
            conferenceRecord: "conferenceRecords/record_1",
            participants: [
                {
                    displayName: "Jitka Dvořáková",
                    source: "signed_in",
                    googleUserId: "users/1",
                },
                {
                    displayName: "jitka dvorakova",
                    source: "anonymous",
                    googleUserId: null,
                },
                {
                    displayName: "Míra Luvin",
                    source: "anonymous",
                    googleUserId: null,
                },
            ],
        });
        await expect(getMeetSpeakerCandidates(input)).resolves.toEqual([
            { name: "Jitka Dvořáková", source: "meet" },
            { name: "Míra Luvin", source: "meet" },
        ]);
    });

    it("returns no partial context after a Meet failure", async () => {
        vi.mocked(getMeetParticipantContext).mockResolvedValue({
            status: "unavailable",
            reason: "incomplete",
        });
        await expect(getMeetSpeakerCandidates(input)).resolves.toEqual([]);
    });
});
