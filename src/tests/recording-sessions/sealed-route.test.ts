import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, expect, it, vi } from "vitest";
import { POST as recover } from "@/app/api/v1/recording-sessions/[id]/recover/route";
import { DELETE as discard } from "@/app/api/v1/recording-sessions/[id]/route";
import { POST as create } from "@/app/api/v1/recording-sessions/sealed/route";
import {
    recorderOfflineKeys,
    recordingCaptureKeys,
    recordingSessionChunks,
    recordingSessions,
} from "@/db/schema";
import { decrypt, encrypt } from "@/lib/encryption";
import { AppError, ErrorCode } from "@/lib/errors";
import vector from "@/tests/fixtures/recorder-sealed-vectors.json";

const mocks = vi.hoisted(() => ({
    gate: vi.fn(),
    db: { transaction: vi.fn(), select: vi.fn(), delete: vi.fn() },
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    assertFolder: vi.fn(),
    requireMeetingAccess: vi.fn(),
}));
vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/lib/env", () => ({ env: { ENCRYPTION_KEY: "01".repeat(32) } }));
vi.mock("@/lib/org/config", () => ({ assertNotOrgAccount: vi.fn() }));
vi.mock("@/lib/meetings/access", () => ({
    meetingViewer: vi.fn(),
    requireMeetingAccess: mocks.requireMeetingAccess,
}));
vi.mock("@/db/queries/agenda-events", () => ({
    publishAgendaEventInTx: vi.fn(),
}));
vi.mock("@/lib/folders/folders", () => ({
    assertCategorizableFolderInput: mocks.assertFolder,
}));
vi.mock("@/lib/pipeline/state", () => ({ readProcessing: vi.fn() }));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn(),
}));
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: mocks.gate,
}));

const dialect = new PgDialect();
const owner = { userId: "owner", apiKeyId: "key" };
const descriptor = {
    protocol: 2,
    kid: vector.kid,
    ephemeralPublicKey: vector.ephemeral.publicKey,
    salt: vector.salt,
};
const input = {
    clientRecordingId: vector.clientRecordingId,
    startedAt: "2026-11-28T01:02:03Z",
    noticeAcknowledgedAt: "2026-11-28T01:02:00Z",
    channelLayout: ["mic"],
    mimeType: "audio/webm",
    encryption: descriptor,
};
const capture = {
    ...owner,
    id: "capture",
    clientRecordingId: input.clientRecordingId,
    activeSessionId: "session",
    status: "active",
    encryptedKey: "encrypted-key",
    expiresAt: new Date(Date.now() + 60_000),
    offlineKid: descriptor.kid,
    ephemeralPublicKey: descriptor.ephemeralPublicKey,
    offlineSalt: descriptor.salt,
};
const session = {
    ...owner,
    id: "session",
    status: "open",
    captureKeyId: capture.id,
    clientRecordingId: input.clientRecordingId,
    startedAt: new Date(input.startedAt),
    noticeAcknowledgedAt: new Date(input.noticeAcknowledgedAt),
    mimeType: input.mimeType,
    metadata: { channelLayout: input.channelLayout },
    folderId: null,
};
const savedRecipient = { privateKey: encrypt(vector.recipient.privateKey) };
type SelectedTable =
    | typeof recorderOfflineKeys
    | typeof recordingSessions
    | typeof recordingCaptureKeys;

function selected(
    table: SelectedTable,
    rows: object[],
    scope: string[],
    select = mocks.select,
) {
    select.mockReturnValueOnce({
        from: (selectedTable: SelectedTable) => {
            expect(selectedTable).toBe(table);
            return {
                where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
                    expect(dialect.sqlToQuery(condition).params).toEqual(
                        expect.arrayContaining(scope),
                    );
                    const result = {
                        for: () => ({ limit: async () => rows }),
                        limit: async () => rows,
                    };
                    return { ...result, orderBy: () => result };
                },
            };
        },
    });
}

function inserted(rows: object[]) {
    mocks.insert.mockReturnValueOnce({
        values: () => ({
            onConflictDoNothing: () => ({ returning: async () => rows }),
            returning: async () => rows,
        }),
    });
}

const writeCapture = vi.fn();
function request(body: object, path = "sealed") {
    return new Request(
        `https://app.example.test/api/v1/recording-sessions/${path}`,
        {
            method: "POST",
            body: JSON.stringify(body),
        },
    );
}
function retry(captureKey: object = capture, current: object = session) {
    inserted([]);
    selected(
        recordingCaptureKeys,
        [captureKey],
        [owner.userId, input.clientRecordingId],
    );
    selected(
        recordingSessions,
        [current],
        [session.id, owner.userId, owner.apiKeyId],
    );
}

beforeEach(() => {
    vi.resetAllMocks();
    mocks.gate.mockResolvedValue({
        authn: { user: { id: owner.userId }, apiKeyId: owner.apiKeyId },
    });
    mocks.db.transaction.mockImplementation((fn) =>
        fn({
            select: mocks.select,
            insert: mocks.insert,
            update: mocks.update,
        }),
    );
    mocks.db.select.mockImplementation(() => ({
        from: (
            table: typeof recordingSessions | typeof recordingSessionChunks,
        ) => {
            if (table === recordingSessions)
                return {
                    where: (
                        condition: Parameters<PgDialect["sqlToQuery"]>[0],
                    ) => {
                        expect(dialect.sqlToQuery(condition).params).toContain(
                            owner.userId,
                        );
                        return sql.empty();
                    },
                };
            expect(table).toBe(recordingSessionChunks);
            return { where: () => ({ orderBy: async () => [] }) };
        },
    }));
    mocks.update.mockReturnValue({ set: writeCapture });
    writeCapture.mockReturnValue({ where: async () => [] });
});

it("stores an encrypted derived key and echoes only protocol and kid", async () => {
    inserted([capture]);
    selected(recorderOfflineKeys, [savedRecipient], [owner.userId, vector.kid]);
    inserted([session]);
    const response = await create(request(input));
    expect(response.status).toBe(201);
    expect((await response.json()).encryption).toEqual({
        protocol: 2,
        kid: vector.kid,
    });
    expect(writeCapture).toHaveBeenCalledWith(
        expect.objectContaining({ activeSessionId: session.id }),
    );
    expect(
        Buffer.from(
            decrypt(writeCapture.mock.calls[0][0].encryptedKey),
            "base64",
        ).toString("base64url"),
    ).toBe(vector.derivedKey);
});

it("refuses a foreign recipient before doing ECDH", async () => {
    inserted([capture]);
    selected(recorderOfflineKeys, [], [owner.userId, vector.kid]);
    const point = Buffer.alloc(65);
    point[0] = 4;
    const response = await create(
        request({
            ...input,
            encryption: {
                ...descriptor,
                ephemeralPublicKey: point.toString("base64url"),
            },
        }),
    );
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
        code: "OFFLINE_KEY_UNAVAILABLE",
    });
    expect(mocks.insert).toHaveBeenCalledTimes(1);
});

it("replays exact requests without revalidating mutable folder or agenda choices", async () => {
    retry();
    const response = await create(
        request({
            ...input,
            folderId: "now-deleted",
            liveAgendaId: "now-deleted",
        }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
        id: session.id,
        folder_id: null,
        encryption: { protocol: 2, kid: vector.kid },
    });
    expect(mocks.assertFolder).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
});

it("opens a capture when a cached folder or agenda is no longer available", async () => {
    inserted([capture]);
    selected(recorderOfflineKeys, [savedRecipient], [owner.userId, vector.kid]);
    inserted([session]);
    mocks.assertFolder.mockRejectedValueOnce(
        new AppError(ErrorCode.INVALID_INPUT, "Folder is unavailable", 400),
    );
    mocks.requireMeetingAccess.mockRejectedValueOnce(
        new AppError(
            ErrorCode.CONFLICT,
            "An absorbed agenda is read-only",
            409,
        ),
    );
    const response = await create(
        request({
            ...input,
            folderId: "gone-folder",
            liveAgendaId: "closed-agenda",
        }),
    );
    expect(response.status).toBe(201);
    expect(mocks.assertFolder).toHaveBeenCalledTimes(1);
    expect(mocks.requireMeetingAccess).toHaveBeenCalledTimes(1);
});

it.each([
    { startedAt: "2026-11-28T01:02:04Z" },
    { noticeAcknowledgedAt: null },
    { channelLayout: ["system"] },
    { mimeType: "audio/ogg" },
    {
        encryption: {
            ...descriptor,
            salt: Buffer.alloc(16).toString("base64url"),
        },
    },
])("rejects a changed immutable field %o", async (patch) => {
    retry();
    const response = await create(request({ ...input, ...patch }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CONFLICT" });
});

it("rejects a collision with a protocol 1 session", async () => {
    retry({
        ...capture,
        offlineKid: null,
        ephemeralPublicKey: null,
        offlineSalt: null,
    });
    expect((await create(request(input))).status).toBe(409);
});

it("replays a sealed capture whose pointer was cleared using scoped session history", async () => {
    inserted([]);
    selected(
        recordingCaptureKeys,
        [{ ...capture, activeSessionId: null }],
        [owner.userId, input.clientRecordingId],
    );
    selected(
        recordingSessions,
        [session],
        [capture.id, owner.userId, owner.apiKeyId],
    );
    const response = await create(request(input));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
        id: session.id,
        encryption: { protocol: 2, kid: vector.kid },
    });
});

it("re-derives the original key during recovery after rollback clears an expired capture's pointer", async () => {
    const aborted = {
        ...session,
        status: "aborted",
        terminalCode: "stale_open",
    };
    selected(
        recordingSessions,
        [aborted],
        [session.id, owner.userId, owner.apiKeyId],
    );
    selected(
        recordingCaptureKeys,
        [
            {
                ...capture,
                activeSessionId: null,
                status: "expired",
                encryptedKey: null,
            },
        ],
        [capture.id, owner.userId, owner.apiKeyId],
    );
    selected(
        recordingSessions,
        [aborted],
        [capture.id, owner.userId, owner.apiKeyId],
    );
    selected(recorderOfflineKeys, [savedRecipient], [owner.userId, vector.kid]);
    inserted([{ ...session, id: "replacement" }]);
    const response = await recover(request({}, "session/recover"), {
        params: Promise.resolve({ id: session.id }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
        id: "replacement",
        encryption: { protocol: 2, kid: vector.kid },
    });
    expect(writeCapture).toHaveBeenCalledWith(
        expect.objectContaining({
            activeSessionId: "replacement",
            status: "active",
        }),
    );
    expect(
        Buffer.from(
            decrypt(writeCapture.mock.calls[0][0].encryptedKey),
            "base64",
        ).toString("base64url"),
    ).toBe(vector.derivedKey);
});

it("runs the regular recorder gate before accepting a sealed request", async () => {
    const error = new AppError(
        ErrorCode.ACCOUNT_LOCKED,
        "Plan has lapsed",
        403,
    );
    mocks.gate.mockRejectedValueOnce(error);
    const response = await create(request(input));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "ACCOUNT_LOCKED" });
    expect(mocks.db.transaction).not.toHaveBeenCalled();
});

it("restores the key and pointer before returning an open historical replacement", async () => {
    const replacement = { ...session, id: "replacement" };
    selected(
        recordingSessions,
        [{ ...session, status: "aborted", terminalCode: "stale_open" }],
        [session.id, owner.userId, owner.apiKeyId],
    );
    selected(
        recordingCaptureKeys,
        [
            {
                ...capture,
                activeSessionId: null,
                expiresAt: new Date(0),
                status: "expired",
                encryptedKey: null,
            },
        ],
        [capture.id, owner.userId, owner.apiKeyId],
    );
    selected(
        recordingSessions,
        [replacement],
        [capture.id, owner.userId, owner.apiKeyId],
    );
    selected(recorderOfflineKeys, [savedRecipient], [owner.userId, vector.kid]);

    const response = await recover(request({}, "session/recover"), {
        params: Promise.resolve({ id: session.id }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
        id: replacement.id,
        status: "open",
    });
    expect(writeCapture).toHaveBeenCalledWith(
        expect.objectContaining({
            activeSessionId: replacement.id,
            status: "active",
        }),
    );
    expect(
        Buffer.from(
            decrypt(writeCapture.mock.calls[0][0].encryptedKey),
            "base64",
        ).toString("base64url"),
    ).toBe(vector.derivedKey);
    expect(mocks.insert).not.toHaveBeenCalled();
});

it("rechecks the current session under lock when a replacement wins the race with DELETE", async () => {
    const old = { ...session, status: "aborted", terminalCode: "stale_open" };
    const replacement = { ...session, id: "replacement" };
    const newBinding = { ...capture, activeSessionId: replacement.id };
    const scope = [capture.id, owner.userId, owner.apiKeyId];
    selected(recordingSessions, [old], [old.id, owner.userId], mocks.db.select);
    for (const [binding, candidate] of [
        [capture, old],
        [newBinding, replacement],
    ] as const) {
        selected(recordingCaptureKeys, [binding], scope);
        selected(recordingSessions, [candidate], [...scope, candidate.id]);
        selected(recordingCaptureKeys, [newBinding], scope);
        selected(recordingSessions, [replacement], [...scope, replacement.id]);
    }
    mocks.db.delete.mockReturnValue({ where: async () => [] });
    const writeSession = vi.fn().mockReturnValue({
        where: async (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
            expect(dialect.sqlToQuery(condition).params).toEqual([
                replacement.id,
                owner.userId,
                owner.apiKeyId,
            ]);
        },
    });
    mocks.update.mockImplementation((table) => ({
        set: table === recordingSessions ? writeSession : writeCapture,
    }));

    const response = await discard(
        new Request(
            "https://app.example.test/api/v1/recording-sessions/session?capture=1",
            { method: "DELETE" },
        ),
        { params: Promise.resolve({ id: session.id }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
        success: true,
        capture_discarded: true,
        capture_outcome: "discarded",
    });
    expect(mocks.db.transaction).toHaveBeenCalledTimes(2);
    expect(writeSession).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
            status: "aborted",
            terminalCode: "user_discard",
            liveUntil: null,
        }),
    );
    expect(writeCapture).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
            activeSessionId: replacement.id,
            status: "discarded",
            encryptedKey: null,
        }),
    );
});

function discardRequest() {
    return discard(
        new Request(
            "https://app.example.test/api/v1/recording-sessions/session?capture=1",
            { method: "DELETE" },
        ),
        { params: Promise.resolve({ id: session.id }) },
    );
}

it("returns a distinct outcome when the sealed capture was already published", async () => {
    const completed = {
        ...session,
        status: "completed",
        recordingId: "recording",
    };
    const scope = [capture.id, owner.userId, owner.apiKeyId];
    selected(
        recordingSessions,
        [completed],
        [session.id, owner.userId],
        mocks.db.select,
    );
    for (let i = 0; i < 2; i++) {
        selected(recordingCaptureKeys, [capture], scope);
        selected(recordingSessions, [completed], [...scope, session.id]);
    }
    const response = await discardRequest();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
        capture_outcome: "completed",
    });
    expect(mocks.update).not.toHaveBeenCalled();
});

it("identifies a credential mismatch on both sealed replay and cancellation", async () => {
    retry({ ...capture, apiKeyId: "previous-key" });
    selected(
        recordingSessions,
        [{ ...session, apiKeyId: "previous-key" }],
        [session.id, owner.userId],
        mocks.db.select,
    );
    for (const response of [
        await create(request(input)),
        await discardRequest(),
    ]) {
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
            code: "RECORDER_KEY_MISMATCH",
        });
    }
});
