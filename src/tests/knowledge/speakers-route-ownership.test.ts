import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "test-secret",
        DATABASE_URL: "postgres://unused",
    },
}));

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        transaction: vi.fn(),
    },
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

// Recording ownership is the access layer's (tested against a real database
// in `src/tests/sharing/`); this file pins the transcript and person scoping.
vi.mock("@/lib/sharing/access", () => ({
    requestedRecordingView: (request: Request) =>
        new URL(request.url).searchParams.get("view") === "org"
            ? "org"
            : "private",
    requireRecordingView: vi.fn(async (userId: string) => ({
        ownerUserId: userId,
        contentUserId: userId,
    })),
}));

const { refreshExistingRecordingSidecars } = vi.hoisted(() => ({
    refreshExistingRecordingSidecars: vi.fn(),
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    refreshExistingRecordingSidecars,
}));

import {
    GET as getSpeakers,
    PUT as putSpeaker,
} from "@/app/api/recordings/[id]/speakers/route";
import { db } from "@/db";
import { transcriptions } from "@/db/schema";
import { exprBindsValue, exprReferencesColumn } from "../fixtures/drizzle-expr";

const RECORDING_ID = "rec-1";

/** Every `where` expression the route built, in the order it built them. */
let wheres: unknown[] = [];

/**
 * One `db.select()` answer. Resolves to `rows` whether the caller ends the
 * chain with `.limit()` or awaits the `where()` directly, so both the
 * transcript lookup and the joined speaker read can share a queue.
 */
function selectAnswer(rows: unknown[]) {
    // A real promise with the terminals assigned onto it resolves whether
    // the caller ends the chain or awaits the `where` directly.
    const afterWhere = Object.assign(Promise.resolve(rows), {
        limit: vi.fn().mockResolvedValue(rows),
        orderBy: vi.fn().mockResolvedValue(rows),
        // The row locks a speaker change takes.
        for: vi.fn().mockResolvedValue(rows),
    });
    const node: Record<string, unknown> = {};
    node.from = vi.fn(() => node);
    node.leftJoin = vi.fn(() => node);
    node.innerJoin = vi.fn(() => node);
    node.where = vi.fn((expr: unknown) => {
        wheres.push(expr);
        return afterWhere;
    });
    return node;
}

function queueSelects(...answers: unknown[][]): void {
    const mock = db.select as Mock;
    for (const rows of answers) {
        mock.mockReturnValueOnce(selectAnswer(rows));
    }
}

function context(id = RECORDING_ID) {
    return { params: Promise.resolve({ id }) };
}

/** The transcript version every change names; `tx-1` at revision 0. */
const SEEN = { transcriptionId: "tx-1", revision: 0 };

function putRequest(body: object, query = ""): Request {
    return new Request(
        `http://localhost/api/recordings/${RECORDING_ID}/speakers${query}`,
        { method: "PUT", body: JSON.stringify({ ...SEEN, ...body }) },
    );
}

describe("speakers route and ownership", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        wheres = [];
        (db.update as Mock).mockReturnValue({
            set: vi.fn().mockReturnValue({ where: vi.fn() }),
        });
        (db.delete as Mock).mockReturnValue({ where: vi.fn() });
        // The writes run in a transaction; here it is the same mock.
        (db.transaction as Mock).mockImplementation(
            async (work: (tx: typeof db) => unknown) => work(db),
        );
    });

    it("scopes the transcript lookup by userId and 404s on somebody else's", async () => {
        queueSelects([]);

        const response = await getSpeakers(
            new Request(
                `http://localhost/api/recordings/${RECORDING_ID}/speakers`,
            ),
            context() as never,
        );

        expect(response.status).toBe(404);
        expect(exprReferencesColumn(wheres[0], transcriptions.userId)).toBe(
            true,
        );
        expect(
            exprReferencesColumn(wheres[0], transcriptions.recordingId),
        ).toBe(true);
    });

    it("refuses to write an attribution against somebody else's transcript", async () => {
        queueSelects([]);

        const response = await putSpeaker(
            putRequest({ label: "speaker_0", personId: "person-1" }),
            context() as never,
        );

        expect(response.status).toBe(404);
        expect(db.insert).not.toHaveBeenCalled();
    });

    it("refuses a personId the session user does not own", async () => {
        // The transcript is the caller's; the person is not, so the person
        // lookup comes back empty.
        queueSelects([{ id: "tx-1", revision: 0 }], []);

        const response = await putSpeaker(
            putRequest({ label: "speaker_0", personId: "person-theirs" }),
            context() as never,
        );

        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
            error: "Person not found",
        });
        // The upsert conflicts on (transcriptionId, label) alone, so the
        // person check is the only thing keeping a caller off a slot.
        expect(db.insert).not.toHaveBeenCalled();
    });

    it("writes a user-confirmed attribution, the only kind that projects", async () => {
        queueSelects(
            [{ id: "tx-1", revision: 0 }],
            [
                {
                    id: "person-1",
                    displayName: "Jan",
                    primaryEmail: null,
                    notes: null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                },
            ],
            // The recording, then the transcript, locked for the change.
            [{ id: RECORDING_ID }],
            [{ revision: 0 }],
            [],
        );
        const values = vi.fn().mockReturnValue({
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        });
        (db.insert as Mock).mockReturnValue({ values });

        const response = await putSpeaker(
            putRequest({ label: "speaker_0", personId: "person-1" }),
            context() as never,
        );

        expect(response.status).toBe(200);
        expect(values).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "user-1",
                transcriptionId: "tx-1",
                label: "speaker_0",
                personId: "person-1",
                source: "user",
                status: "confirmed",
                confirmedByUserId: "user-1",
            }),
        );
        expect(refreshExistingRecordingSidecars).toHaveBeenCalledWith(
            "user-1",
            RECORDING_ID,
        );
    });

    it("requires the transcript version a change was made on", async () => {
        const bodies = [
            { transcriptionId: undefined },
            { revision: undefined },
            { revision: -1 },
            { revision: 1.5 },
            { revision: "0" },
            { transcriptionId: 7 },
            { transcriptionId: "" },
        ];
        for (const version of bodies) {
            const response = await putSpeaker(
                putRequest({ label: "speaker_0", unknown: true, ...version }),
                context() as never,
            );
            expect(response.status).toBe(400);
        }
        expect(db.select).not.toHaveBeenCalled();
        expect(db.insert).not.toHaveBeenCalled();
    });

    it("refuses a change made on another transcript or an older revision", async () => {
        for (const seen of [
            { transcriptionId: "tx-erased" },
            { revision: 2 },
        ]) {
            queueSelects([{ id: "tx-1", revision: 3 }]);
            const response = await putSpeaker(
                putRequest({
                    label: "speaker_0",
                    unknown: true,
                    revision: 3,
                    ...seen,
                }),
                context() as never,
            );
            expect(response.status).toBe(409);
        }
        expect(db.insert).not.toHaveBeenCalled();
    });

    it("refuses a change when the transcript is rewritten under it", async () => {
        // The route saw revision 0; by the time the lock is held a
        // re-transcription has committed revision 1.
        queueSelects(
            [{ id: "tx-1", revision: 0 }],
            [{ id: RECORDING_ID }],
            [{ revision: 1 }],
        );

        const response = await putSpeaker(
            putRequest({ label: "speaker_0", unknown: true }),
            context() as never,
        );

        expect(response.status).toBe(409);
        expect(db.insert).not.toHaveBeenCalled();
    });

    it("attributes against the transcript the caller named, not the recording", async () => {
        queueSelects([{ id: "tx-plaud" }], []);

        await getSpeakers(
            new Request(
                `http://localhost/api/recordings/${RECORDING_ID}/speakers?source=plaud`,
            ),
            context() as never,
        );
        const plaudWhere = wheres[0];

        wheres = [];
        queueSelects([{ id: "tx-riffado" }], []);
        await getSpeakers(
            new Request(
                `http://localhost/api/recordings/${RECORDING_ID}/speakers`,
            ),
            context() as never,
        );
        const riffadoWhere = wheres[0];

        // One recording can hold two transcripts whose speaker_0 is a
        // different human, which is why the overlay hangs off the transcript.
        expect(exprBindsValue(plaudWhere, "plaud")).toBe(true);
        expect(exprBindsValue(plaudWhere, "riffado")).toBe(false);
        expect(exprBindsValue(riffadoWhere, "riffado")).toBe(true);
    });
});
