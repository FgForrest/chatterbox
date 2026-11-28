import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, expect, it, vi } from "vitest";
import {
    endRecordingSessionLease,
    renewRecordingSessionLease,
} from "@/db/queries/recording-session-leases";
import { recordingSessions } from "@/db/schema";

const mocks = vi.hoisted(() => ({
    update: vi.fn(),
    set: vi.fn(),
    where: vi.fn(),
    returning: vi.fn(),
}));
vi.mock("@/db", () => ({ db: { update: mocks.update } }));

const dialect = new PgDialect();
const scope = {
    sessionId: "session",
    userId: "owner",
    apiKeyId: "bound-key",
    revision: 3,
};
const ownerGuard =
    '"recording_sessions"."id" = $1 and "recording_sessions"."user_id" = $2 and "recording_sessions"."api_key_id" = $3 and "recording_sessions"."status" = $4 and "recording_sessions"."lease_ended_at" is null';

beforeEach(() => {
    vi.resetAllMocks();
    mocks.update.mockReturnValue({ set: mocks.set });
    mocks.set.mockReturnValue({ where: mocks.where });
    mocks.where.mockReturnValue({ returning: mocks.returning });
    mocks.returning.mockResolvedValue([{ id: scope.sessionId }]);
});

it.each([
    "hashed-room",
    null,
])("renews or moves atomically, with equal revisions limited to the same room (%s)", async (room) => {
    expect(await renewRecordingSessionLease(scope, room)).toBe(true);
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith(recordingSessions);
    const [patch] = mocks.set.mock.calls[0];
    expect(patch).toMatchObject({
        leaseRevision: scope.revision,
        liveRoomKey: room,
    });
    expect(dialect.sqlToQuery(patch.liveUntil as SQL).sql).toBe(
        "now() + interval '60 seconds'",
    );

    const query = dialect.sqlToQuery(mocks.where.mock.calls[0][0] as SQL);
    expect(query.sql).toContain(ownerGuard);
    expect(query.sql).toContain('"recording_sessions"."lease_revision" < $5');
    expect(query.sql).toContain(
        '"recording_sessions"."lease_revision" = $6 and "recording_sessions"."live_room_key" is not distinct from $7',
    );
    expect(query.params).toEqual([
        scope.sessionId,
        scope.userId,
        scope.apiKeyId,
        "open",
        scope.revision,
        scope.revision,
        room,
    ]);
});

it("ends the open lease with a strictly newer revision and clears its room in the same update", async () => {
    expect(await endRecordingSessionLease(scope)).toBe(true);
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith(recordingSessions);
    const [patch] = mocks.set.mock.calls[0];
    expect(patch).toMatchObject({
        leaseRevision: scope.revision,
        liveUntil: null,
        liveRoomKey: null,
    });
    expect(dialect.sqlToQuery(patch.leaseEndedAt as SQL).sql).toBe("now()");
    const query = dialect.sqlToQuery(mocks.where.mock.calls[0][0] as SQL);
    expect(query.sql).toContain(ownerGuard);
    expect(query.sql).toContain('"recording_sessions"."lease_revision" < $5');
    expect(query.params).toEqual([
        scope.sessionId,
        scope.userId,
        scope.apiKeyId,
        "open",
        scope.revision,
    ]);
});

it("reports refusal when the conditional write returns no session", async () => {
    mocks.returning.mockResolvedValue([]);
    expect(await renewRecordingSessionLease(scope, "hashed-room")).toBe(false);
    expect(await endRecordingSessionLease(scope)).toBe(false);
});
