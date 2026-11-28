import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { queryRoomRecorders } from "@/db/queries/recorder-rooms";
import {
    endRecordingSessionLease,
    renewRecordingSessionLease,
} from "@/db/queries/recording-session-leases";
import {
    apiKeys,
    chatterItems,
    recorderOfflineKeys,
    recordingCaptureKeys,
    recordingSessions,
    recordings,
    userAccessStates,
    users,
} from "@/db/schema";
import { encrypt } from "@/lib/encryption";
import { encryptText } from "@/lib/encryption/fields";
import { recorderRoomKeyFor } from "@/lib/meetings/room-key";
import {
    getOrCreateRecorderOfflineKey,
    type SealedCapture,
} from "@/lib/recording-sessions/offline-key";
import {
    createRecordingSession,
    createSealedRecordingSession,
    discardSealedRecordingCapture,
    expireRecordingCaptureKeys,
    getRecordingCaptureKey,
    markRecordingSessionAborted,
    markRecordingSessionCompleted,
    markRecordingSessionCompleting,
    replaceRecordingSession,
    retireRecordingCaptureKey,
} from "@/lib/recording-sessions/store";
import vector from "@/tests/fixtures/recorder-sealed-vectors.json";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestDatabase,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const dbRef = vi.hoisted(() => ({ current: null as TestDatabase | null }));
vi.mock("@/db", () => ({
    sqlClient: null,
    db: new Proxy(
        {},
        {
            get(_, property: keyof TestDatabase) {
                if (!dbRef.current)
                    throw new Error("Test database not initialized");
                const value = dbRef.current[property];
                return typeof value === "function"
                    ? value.bind(dbRef.current)
                    : value;
            },
        },
    ),
}));
vi.mock("@/lib/env", () => ({
    env: {
        AUTHZ_MODE: "idp",
        IDENTITY_PROVIDER: "keycloak",
        SELF_HOST_MODE: "shared",
        ENCRYPTION_KEY: "01".repeat(32),
        BETTER_AUTH_SECRET: "integration-room-lookup-secret",
    },
}));

const url = getTestDatabaseUrl();
const viewer = "viewer";
const owner = "owner";
const eligible = "eligible";
const ungranted = "ungranted";
const suspended = "suspended";
const org = "organization";
const people = [
    { id: viewer, name: "Viewer" },
    { id: owner, name: "Jitka Dvořáková" },
    { id: eligible, name: "A".repeat(200) },
    { id: ungranted, name: "Former colleague" },
    { id: suspended, name: "Suspended colleague", suspendedAt: new Date() },
    { id: org, name: "Organization", role: "org" as const },
];
const descriptor: SealedCapture = {
    protocol: 2,
    kid: vector.kid,
    ephemeralPublicKey: vector.ephemeral.publicKey,
    salt: vector.salt,
};
function input(userId: string, clientRecordingId: string = randomUUID()) {
    return {
        userId,
        apiKeyId: `${userId}-key`,
        clientRecordingId,
        mimeType: "audio/webm",
        metadata: { channelLayout: ["mic"] },
        startedAt: new Date("2026-11-28T01:02:03Z"),
        noticeAcknowledgedAt: new Date("2026-11-28T01:02:02Z"),
        folderId: null,
    };
}

describe.skipIf(!url)(
    "recorder room leases and sealed session persistence",
    () => {
        let database: TestPostgresDatabase;

        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                url ?? "",
                "recorder_sealed",
            );
            dbRef.current = database.db;
            await database.db.insert(users).values(
                people.map((person) => ({
                    ...person,
                    email: `${person.id}@example.test`,
                })),
            );
            await database.db.insert(apiKeys).values(
                people.map(({ id }) => ({
                    id: `${id}-key`,
                    userId: id,
                    name: "Recorder",
                    keyHash: `hash-${id}`,
                    keyPrefix: "test",
                    scopes: ["recordings:write"],
                })),
            );
            await database.db.insert(userAccessStates).values(
                people.map(({ id }) => ({
                    userId: id,
                    issuer: "https://identity.example.test",
                    subject: id,
                    capabilities: id === ungranted ? [] : ["use"],
                    status: "active" as const,
                    source: "login" as const,
                    verifiedAt: new Date(),
                })),
            );
            await database.db.insert(recorderOfflineKeys).values({
                id: descriptor.kid,
                userId: owner,
                publicKey: vector.recipient.publicKey,
                privateKey: encrypt(vector.recipient.privateKey),
                retiredAt: new Date(),
            });
        }, 120_000);

        afterAll(async () => {
            dbRef.current = null;
            await database?.dispose();
        }, 30_000);

        async function readLease(id: string, userId: string) {
            const [session] = await database.db
                .select()
                .from(recordingSessions)
                .where(
                    and(
                        eq(recordingSessions.id, id),
                        eq(recordingSessions.userId, userId),
                    ),
                );
            return session;
        }

        it("orders lease renewals, room moves, clears, and terminal end on the database clock", async () => {
            const { session } = await createRecordingSession(input(owner));
            const scope = {
                sessionId: session.id,
                userId: owner,
                apiKeyId: session.apiKeyId,
            };
            const roomA = recorderRoomKeyFor("zoom:12345678901");
            const roomB = recorderRoomKeyFor("zoom:98765432109");
            const renew = (revision: number, room: string | null) =>
                renewRecordingSessionLease({ ...scope, revision }, room);
            expect(await renew(1, roomA)).toBe(true);
            const [clock] = await database.sql`select now() as now`;
            expect(
                (await readLease(session.id, owner)).liveUntil?.getTime() ?? 0,
            ).toBeGreaterThan(new Date(clock.now).getTime() + 58_000);
            expect(await renew(1, roomA)).toBe(true);
            expect(await renew(1, roomB)).toBe(false);
            expect(await renew(2, roomB)).toBe(true);
            expect(await renew(1, roomA)).toBe(false);
            expect((await readLease(session.id, owner)).liveRoomKey).toBe(
                roomB,
            );
            expect(await renew(3, null)).toBe(true);
            expect(
                (await readLease(session.id, owner)).liveUntil,
            ).toBeInstanceOf(Date);
            expect(await renew(3, null)).toBe(true);
            expect(await renew(4, roomA)).toBe(true);
            expect(
                await endRecordingSessionLease({ ...scope, revision: 4 }),
            ).toBe(false);
            expect(
                await endRecordingSessionLease({ ...scope, revision: 5 }),
            ).toBe(true);
            expect(await renew(6, roomA)).toBe(false);
            expect(await readLease(session.id, owner)).toMatchObject({
                liveUntil: null,
                liveRoomKey: null,
                leaseRevision: 5,
                leaseEndedAt: expect.any(Date),
            });
        });

        it("rejects other owners and keys, and clears leases when sessions complete or abort", async () => {
            for (const transition of [
                "completing",
                "stale_open",
                "user_discard",
            ] as const) {
                const { session } = await createRecordingSession(input(owner));
                const scope = {
                    sessionId: session.id,
                    userId: owner,
                    apiKeyId: session.apiKeyId,
                };
                const roomKey = recorderRoomKeyFor("jitsi:team-sync");
                expect(
                    await renewRecordingSessionLease(
                        { ...scope, revision: 1, userId: viewer },
                        roomKey,
                    ),
                ).toBe(false);
                expect(
                    await renewRecordingSessionLease(
                        { ...scope, revision: 1, apiKeyId: `${viewer}-key` },
                        roomKey,
                    ),
                ).toBe(false);
                expect(
                    await endRecordingSessionLease({
                        ...scope,
                        revision: 1,
                        userId: viewer,
                    }),
                ).toBe(false);
                expect(
                    await renewRecordingSessionLease(
                        { ...scope, revision: 1 },
                        roomKey,
                    ),
                ).toBe(true);
                if (transition === "completing") {
                    await markRecordingSessionCompleting({
                        ...scope,
                        expectedChunkCount: 0,
                        endedAt: new Date(),
                        stopReason: "user",
                        truncatedAtChunk: null,
                    });
                } else {
                    await markRecordingSessionAborted(
                        session.id,
                        owner,
                        transition,
                        null,
                    );
                }
                expect(
                    await renewRecordingSessionLease(
                        { ...scope, revision: 2 },
                        roomKey,
                    ),
                ).toBe(false);
                expect(
                    await endRecordingSessionLease({ ...scope, revision: 2 }),
                ).toBe(false);
                expect(await readLease(session.id, owner)).toMatchObject({
                    liveUntil: null,
                    liveRoomKey: null,
                });
            }
        });

        it("looks up exact live rooms once per active recipient, with names only in deterministic order", async () => {
            const room = recorderRoomKeyFor("meet:abc-defg-hij") ?? "";
            const [clock] = await database.sql`select now() as now`;
            const earliest = new Date(new Date(clock.now).getTime() + 30_000);
            for (const [index, user] of [
                viewer,
                owner,
                owner,
                eligible,
                ungranted,
                suspended,
            ].entries()) {
                const { session } = await createRecordingSession(input(user));
                expect(
                    await renewRecordingSessionLease(
                        { ...session, sessionId: session.id, revision: 1 },
                        room,
                    ),
                ).toBe(true);
                if (index === 2 || index === 4) {
                    await database.db
                        .update(recordingSessions)
                        .set({
                            liveUntil: new Date(
                                earliest.getTime() - (index === 4 ? 15_000 : 0),
                            ),
                        })
                        .where(
                            and(
                                eq(recordingSessions.id, session.id),
                                eq(recordingSessions.userId, user),
                            ),
                        );
                }
            }
            const { session: expired } = await createRecordingSession(
                input(eligible),
            );
            const expiredRoom = recorderRoomKeyFor("zoom:22345678901") ?? "";
            await renewRecordingSessionLease(
                { ...expired, sessionId: expired.id, revision: 1 },
                expiredRoom,
            );
            await database.db
                .update(recordingSessions)
                .set({ liveUntil: new Date(0) })
                .where(
                    and(
                        eq(recordingSessions.id, expired.id),
                        eq(recordingSessions.userId, eligible),
                    ),
                );
            const answer = await queryRoomRecorders(viewer, room);
            expect(answer).toEqual({
                data: [{ name: "A".repeat(120) }, { name: "Jitka Dvořáková" }],
                live_until: earliest.toISOString(),
                freshForMs: expect.any(Number),
            });
            expect(answer.freshForMs).toBeGreaterThan(0);
            expect(answer.freshForMs).toBeLessThanOrEqual(30_000);
            expect(await queryRoomRecorders(viewer, expiredRoom)).toEqual({
                data: [],
                live_until: null,
                freshForMs: 0,
            });
            expect(
                await queryRoomRecorders(
                    viewer,
                    recorderRoomKeyFor("meet:jkl-mnop-qrs") ?? "",
                ),
            ).toEqual({ data: [], live_until: null, freshForMs: 0 });
        });

        it("creates one current offline key per caller concurrently, preserving retired keys", async () => {
            const keys = await Promise.all(
                Array.from({ length: 6 }, () =>
                    getOrCreateRecorderOfflineKey(owner),
                ),
            );
            expect(keys).toEqual(Array(6).fill(keys[0]));
            expect(keys[0]).toMatchObject({
                alg: "ECDH-P256-HKDF-SHA256-A256GCM",
            });
            expect(keys[0].kid).not.toBe(vector.kid);
            const rows = await database.db
                .select()
                .from(recorderOfflineKeys)
                .where(eq(recorderOfflineKeys.userId, owner));
            expect(rows).toHaveLength(2);
            expect(
                rows.find(({ id }) => id === keys[0].kid)?.privateKey,
            ).toMatch(/^[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/);
            expect((await getOrCreateRecorderOfflineKey(viewer)).kid).not.toBe(
                keys[0].kid,
            );
        });

        it("scopes sealed keys to their owner and rolls back malformed-point reservations", async () => {
            await expect(
                createSealedRecordingSession(input(viewer), descriptor),
            ).rejects.toMatchObject({
                statusCode: 410,
                code: "OFFLINE_KEY_UNAVAILABLE",
            });
            const request = input(owner);
            const point = Buffer.alloc(65);
            point[0] = 4;
            await expect(
                createSealedRecordingSession(request, {
                    ...descriptor,
                    ephemeralPublicKey: point.toString("base64url"),
                }),
            ).rejects.toMatchObject({ statusCode: 400 });
            expect(
                await createSealedRecordingSession(request, descriptor),
            ).toMatchObject({ replayed: false });
        });

        it("atomically replays an exact sealed create and rejects immutable and protocol collisions", async () => {
            const request = input(owner);
            const results = await Promise.all(
                Array.from({ length: 6 }, () =>
                    createSealedRecordingSession(request, descriptor),
                ),
            );
            expect(new Set(results.map(({ session }) => session.id)).size).toBe(
                1,
            );
            expect(results.filter(({ replayed }) => !replayed)).toHaveLength(1);
            const session = results[0].session;
            expect(
                await createSealedRecordingSession(
                    {
                        ...request,
                        folderId: "gone-folder",
                        metadata: {
                            ...request.metadata,
                            liveAgendaId: "gone-agenda",
                            roomKey: "changed",
                        },
                    },
                    descriptor,
                ),
            ).toMatchObject({
                replayed: true,
                session: { id: session.id, folderId: null },
            });
            for (const mutation of [
                { startedAt: new Date() },
                { noticeAcknowledgedAt: null },
                { mimeType: "audio/ogg" },
                { metadata: { channelLayout: ["system"] } },
            ]) {
                await expect(
                    createSealedRecordingSession(
                        { ...request, ...mutation },
                        descriptor,
                    ),
                ).rejects.toMatchObject({ statusCode: 409 });
            }
            await expect(
                createSealedRecordingSession(request, {
                    ...descriptor,
                    salt: Buffer.alloc(16).toString("base64url"),
                }),
            ).rejects.toMatchObject({ statusCode: 409 });
            const legacy = input(owner);
            expect(await createRecordingSession(legacy)).toHaveProperty("key");
            await expect(
                createSealedRecordingSession(legacy, descriptor),
            ).rejects.toMatchObject({ statusCode: 409 });
            await expect(createRecordingSession(request)).rejects.toMatchObject(
                { statusCode: 409 },
            );
        });

        it("recovers sealed bytes after key material expiry, with the same descriptor and a stable replacement", async () => {
            const request = input(owner, vector.clientRecordingId);
            const { session } = await createSealedRecordingSession(
                request,
                descriptor,
            );
            const recover = {
                userId: owner,
                apiKeyId: session.apiKeyId,
                sessionId: session.id,
            };
            await endRecordingSessionLease({ ...recover, revision: 1 });
            await markRecordingSessionAborted(
                session.id,
                owner,
                "stale_open",
                null,
            );
            await database.db
                .update(recordingCaptureKeys)
                .set({ expiresAt: new Date(0) })
                .where(
                    and(
                        eq(recordingCaptureKeys.id, session.captureKeyId),
                        eq(recordingCaptureKeys.userId, owner),
                    ),
                );
            await expireRecordingCaptureKeys(50);
            const [expired] = await database.db
                .select()
                .from(recordingCaptureKeys)
                .where(
                    and(
                        eq(recordingCaptureKeys.id, session.captureKeyId),
                        eq(recordingCaptureKeys.userId, owner),
                    ),
                );
            expect(expired).toMatchObject({
                encryptedKey: null,
                status: "expired",
                offlineKid: descriptor.kid,
            });
            await database.db
                .update(recordingCaptureKeys)
                .set({ activeSessionId: null })
                .where(
                    and(
                        eq(recordingCaptureKeys.id, session.captureKeyId),
                        eq(recordingCaptureKeys.userId, owner),
                    ),
                );
            expect(
                await createSealedRecordingSession(request, descriptor),
            ).toMatchObject({
                replayed: true,
                session: { id: session.id, status: "aborted" },
            });

            const { session: replacement, sealed } =
                await replaceRecordingSession(recover);
            expect(replacement.id).not.toBe(session.id);
            expect(sealed).toEqual(descriptor);
            expect(
                await renewRecordingSessionLease(
                    { ...recover, sessionId: replacement.id, revision: 2 },
                    "room-key",
                ),
            ).toBe(false);
            expect(
                (
                    await getRecordingCaptureKey({
                        ...recover,
                        session: replacement,
                    })
                )?.toString("base64url"),
            ).toBe(vector.derivedKey);
            expect(await replaceRecordingSession(recover)).toMatchObject({
                session: { id: replacement.id },
            });
            expect(
                await createSealedRecordingSession(request, descriptor),
            ).toMatchObject({ session: { id: replacement.id } });
        });

        it.each([
            "recover",
            "replay",
        ])("restores the key and pointer before %s returns an open rollback replacement", async (method) => {
            const request = input(owner);
            const { session: original } = await createSealedRecordingSession(
                request,
                descriptor,
            );
            const scope = { userId: owner, apiKeyId: original.apiKeyId };
            const key = await getRecordingCaptureKey({
                ...scope,
                session: original,
            });
            expect(key).toBeInstanceOf(Buffer);
            await markRecordingSessionAborted(
                original.id,
                owner,
                "stale_open",
                null,
            );
            const { session: replacement } = await replaceRecordingSession({
                ...scope,
                sessionId: original.id,
            });
            await database.db
                .update(recordingCaptureKeys)
                .set({
                    activeSessionId: null,
                    expiresAt: new Date(0),
                    encryptedKey: null,
                    status: "expired",
                })
                .where(
                    and(
                        eq(recordingCaptureKeys.id, original.captureKeyId),
                        eq(recordingCaptureKeys.userId, owner),
                    ),
                );

            const result =
                method === "recover"
                    ? await replaceRecordingSession({
                          ...scope,
                          sessionId: original.id,
                      })
                    : await createSealedRecordingSession(request, descriptor);
            expect(result.session).toMatchObject({
                id: replacement.id,
                status: "open",
            });
            expect(
                await getRecordingCaptureKey({
                    ...scope,
                    session: result.session,
                }),
            ).toEqual(key);
        });

        it("discards the current replacement from a historical session ID and keeps the capture retired", async () => {
            const request = input(owner);
            const { session: original } = await createSealedRecordingSession(
                request,
                descriptor,
            );
            const scope = {
                userId: owner,
                apiKeyId: original.apiKeyId,
                sessionId: original.id,
            };
            await markRecordingSessionAborted(
                original.id,
                owner,
                "stale_open",
                null,
            );
            const { session: replacement } =
                await replaceRecordingSession(scope);
            await renewRecordingSessionLease(
                { ...scope, sessionId: replacement.id, revision: 1 },
                "test-room",
            );
            await expect(
                discardSealedRecordingCapture({ ...scope, userId: viewer }),
            ).rejects.toMatchObject({ statusCode: 404 });
            await expect(
                discardSealedRecordingCapture({
                    ...scope,
                    apiKeyId: `${viewer}-key`,
                }),
            ).rejects.toMatchObject({ statusCode: 403 });
            expect(await readLease(replacement.id, owner)).toMatchObject({
                status: "open",
                liveRoomKey: "test-room",
            });
            for (const id of [original.id, replacement.id]) {
                expect(
                    await discardSealedRecordingCapture({
                        ...scope,
                        sessionId: id,
                    }),
                ).toEqual({ sessionId: replacement.id, purge: true });
            }
            expect(await readLease(replacement.id, owner)).toMatchObject({
                status: "aborted",
                terminalCode: "user_discard",
                liveRoomKey: null,
                liveUntil: null,
            });
            expect(await replaceRecordingSession(scope)).toMatchObject({
                session: { id: replacement.id, status: "aborted" },
            });
            expect(
                await createSealedRecordingSession(request, descriptor),
            ).toMatchObject({
                session: { id: replacement.id, status: "aborted" },
            });
        });

        it("returns the completed or discarded tombstone on sealed replay", async () => {
            const complete = input(owner);
            const discard = input(owner);
            const { session: completed } = await createSealedRecordingSession(
                complete,
                descriptor,
            );
            const { session: discarded } = await createSealedRecordingSession(
                discard,
                descriptor,
            );
            await markRecordingSessionCompleting({
                sessionId: completed.id,
                userId: owner,
                expectedChunkCount: 0,
                endedAt: new Date(),
                stopReason: "user",
                truncatedAtChunk: null,
            });
            const recordingId = "sealed-finalized-audio";
            await database.db.insert(chatterItems).values({
                id: recordingId,
                userId: owner,
                kind: "audio",
                title: encryptText("Test recording"),
                occurredAt: new Date(),
            });
            await database.db.insert(recordings).values({
                id: recordingId,
                userId: owner,
                deviceSn: "test-recorder",
                plaudFileId: recordingId,
                duration: 1,
                endTime: new Date(),
                filesize: 1,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: "test.ogg",
                plaudVersion: "1",
            });
            expect(
                await markRecordingSessionCompleted(
                    completed.id,
                    owner,
                    recordingId,
                ),
            ).toBe(true);
            await markRecordingSessionAborted(
                discarded.id,
                owner,
                "user_discard",
                null,
            );
            await retireRecordingCaptureKey({
                userId: owner,
                captureKeyId: discarded.captureKeyId,
                sessionId: discarded.id,
            });
            for (const session of [completed, discarded]) {
                await database.db
                    .update(recordingCaptureKeys)
                    .set({ activeSessionId: null })
                    .where(
                        and(
                            eq(recordingCaptureKeys.id, session.captureKeyId),
                            eq(recordingCaptureKeys.userId, owner),
                        ),
                    );
                expect(
                    await replaceRecordingSession({
                        sessionId: session.id,
                        apiKeyId: session.apiKeyId,
                        userId: owner,
                    }),
                ).toMatchObject({
                    session: { id: session.id },
                    sealed: descriptor,
                });
            }
            expect(
                await createSealedRecordingSession(complete, descriptor),
            ).toMatchObject({
                session: { id: completed.id, status: "completed" },
            });
            expect(
                await createSealedRecordingSession(discard, descriptor),
            ).toMatchObject({
                session: { id: discarded.id, terminalCode: "user_discard" },
            });
        });
    },
);
