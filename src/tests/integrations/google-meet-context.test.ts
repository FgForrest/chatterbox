import { describe, expect, it, vi } from "vitest";
import { getMeetParticipantContext } from "@/lib/integrations/google/meet-context";

const now = new Date("2026-10-09T12:00:00.000Z");
const recordingStartedAt = new Date("2026-10-08T10:00:00.000Z");
const recordingEndedAt = new Date("2026-10-08T11:00:00.000Z");
const record = {
    name: "conferenceRecords/record_1",
    startTime: "2026-10-08T09:55:00.000Z",
    endTime: "2026-10-08T11:05:00.000Z",
    expireTime: "2026-11-07T11:05:00.000Z",
};

function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function input(fetchImpl: typeof fetch) {
    return {
        accessToken: "token",
        meetingCode: "abc-defg-hij",
        recordingStartedAt,
        recordingEndedAt,
        now,
        fetchImpl,
    };
}

describe("getMeetParticipantContext", () => {
    it("returns bounded identity candidates but excludes phone numbers", async () => {
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(response({ conferenceRecords: [record] }))
            .mockResolvedValueOnce(
                response({
                    participants: [
                        {
                            signedinUser: {
                                user: "users/123",
                                displayName: "Alice Smith",
                            },
                        },
                        { anonymousUser: { displayName: "Bob" } },
                        { phoneUser: { displayName: "+1 555 *** 1234" } },
                    ],
                }),
            );

        await expect(
            getMeetParticipantContext(input(fetchImpl)),
        ).resolves.toEqual({
            status: "available",
            conferenceRecord: record.name,
            participants: [
                {
                    displayName: "Alice Smith",
                    source: "signed_in",
                    googleUserId: "users/123",
                },
                {
                    displayName: "Bob",
                    source: "anonymous",
                    googleUserId: null,
                },
            ],
        });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        const firstUrl = new URL(String(fetchImpl.mock.calls[0][0]));
        expect(firstUrl.searchParams.get("filter")).toBe(
            'space.meeting_code = "abc-defg-hij"',
        );
        expect(firstUrl.hostname).toBe("meet.googleapis.com");
    });

    it("does not expose candidates when multiple conferences overlap", async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
            response({
                conferenceRecords: [
                    record,
                    { ...record, name: "conferenceRecords/other" },
                ],
            }),
        );
        await expect(
            getMeetParticipantContext(input(fetchImpl)),
        ).resolves.toEqual({
            status: "unavailable",
            reason: "ambiguous_match",
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("does not use an expired conference record", async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
            response({
                conferenceRecords: [
                    { ...record, expireTime: "2026-10-09T11:00:00.000Z" },
                ],
            }),
        );
        await expect(
            getMeetParticipantContext(input(fetchImpl)),
        ).resolves.toEqual({ status: "unavailable", reason: "no_match" });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("rejects expired records and recordings without an HTTP call", async () => {
        const fetchImpl = vi.fn<typeof fetch>();
        await expect(
            getMeetParticipantContext({
                ...input(fetchImpl),
                recordingStartedAt: new Date("2026-08-01T10:00:00.000Z"),
                recordingEndedAt: new Date("2026-08-01T11:00:00.000Z"),
            }),
        ).resolves.toEqual({ status: "unavailable", reason: "expired" });
        await expect(
            getMeetParticipantContext({
                ...input(fetchImpl),
                meetingCode: 'abc" OR start_time >= "x',
            }),
        ).resolves.toEqual({ status: "unavailable", reason: "invalid_input" });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("rejects incomplete pagination instead of returning a partial list", async () => {
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(response({ conferenceRecords: [record] }))
            .mockResolvedValueOnce(
                response({
                    participants: [{ anonymousUser: { displayName: "A" } }],
                    nextPageToken: "2",
                }),
            )
            .mockResolvedValueOnce(
                response({
                    participants: [{ anonymousUser: { displayName: "B" } }],
                    nextPageToken: "3",
                }),
            );
        await expect(
            getMeetParticipantContext(input(fetchImpl)),
        ).resolves.toEqual({ status: "unavailable", reason: "incomplete" });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it("fails closed on a revoked grant", async () => {
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValue(response({}, 403));
        await expect(
            getMeetParticipantContext(input(fetchImpl)),
        ).resolves.toEqual({ status: "unavailable", reason: "request_failed" });
    });
});
