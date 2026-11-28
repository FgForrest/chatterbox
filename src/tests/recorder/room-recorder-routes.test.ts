import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as config } from "@/app/api/v1/recorder/config/route";
import { POST as lookup } from "@/app/api/v1/recorder/rooms/recorders/route";
import { POST as end } from "@/app/api/v1/recording-sessions/[id]/lease/end/route";
import { POST as renew } from "@/app/api/v1/recording-sessions/[id]/lease/route";
import { recorderRoomKeyFor } from "@/lib/meetings/room-key";
import type * as rateLimit from "@/lib/rate-limit";

const mocks = vi.hoisted(() => ({
    env: {
        SELF_HOST_MODE: "shared",
        IS_HOSTED: false,
        BETTER_AUTH_SECRET: "room-recorder-secret",
    },
    gate: vi.fn(),
    query: vi.fn(),
    bucket: vi.fn(),
    renew: vi.fn(),
    end: vi.fn(),
    getSession: vi.fn(),
    getOfflineKey: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: mocks.gate,
}));
vi.mock("@/db/queries/recorder-rooms", () => ({
    queryRoomRecorders: mocks.query,
}));
vi.mock("@/db/queries/recording-session-leases", () => ({
    renewRecordingSessionLease: mocks.renew,
    endRecordingSessionLease: mocks.end,
}));
vi.mock("@/lib/recording-sessions/store", () => ({
    getRecordingSessionForUser: mocks.getSession,
}));
vi.mock("@/lib/recording-sessions/offline-key", () => ({
    getOrCreateRecorderOfflineKey: mocks.getOfflineKey,
}));
vi.mock("@/lib/recorder/config", () => ({
    getRecorderServerConfig: () => ({}),
    serializeRecorderServerConfig: () => ({ encrypted_recording_protocol: 1 }),
}));
vi.mock("@/lib/rate-limit", async (original) => ({
    ...(await original<typeof rateLimit>()),
    consumeRateLimitBucket: mocks.bucket,
    getClientIp: () => "192.0.2.5",
}));

const room = "meet:abc-defg-hij";
const scope = { userId: "viewer", apiKeyId: "bound-key", sessionId: "session" };
const context = { params: Promise.resolve({ id: scope.sessionId }) };
const lookupPath = "/api/v1/recorder/rooms/recorders";
const leasePath = "/api/v1/recording-sessions/session/lease";
function request(path: string, body: unknown) {
    return new Request(`https://app.example.test${path}`, {
        method: "POST",
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.resetAllMocks();
    mocks.env.IS_HOSTED = false;
    mocks.env.SELF_HOST_MODE = "shared";
    mocks.gate.mockResolvedValue({
        authn: { user: { id: scope.userId }, apiKeyId: scope.apiKeyId },
    });
    mocks.bucket.mockResolvedValue({ allowed: true });
    mocks.query.mockResolvedValue({
        data: [],
        live_until: null,
        freshForMs: 0,
    });
    mocks.renew.mockResolvedValue(true);
    mocks.end.mockResolvedValue(true);
    mocks.getOfflineKey.mockImplementation(async (id: string) => ({
        kid: `${id}-kid`,
        publicKey: "spki",
        alg: "ECDH-P256-HKDF-SHA256-A256GCM",
    }));
});

it.each([
    { hosted: true, mode: "shared" },
    { hosted: false, mode: "local" },
])("hides the lookup and lease endpoints in $mode mode (hosted=$hosted)", async ({
    hosted,
    mode,
}) => {
    mocks.env.IS_HOSTED = hosted;
    mocks.env.SELF_HOST_MODE = mode;
    for (const response of [
        await lookup(request(lookupPath, { room })),
        await renew(request(leasePath, { room, revision: 0 }), context),
        await end(request(`${leasePath}/end`, { revision: 1 }), context),
    ]) {
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
    }
    expect(mocks.gate).not.toHaveBeenCalled();
});

it("keeps the offline config in all modes and binds its identity to the account across recorder keys", async () => {
    const getConfig = async () =>
        (
            await config(
                new Request("https://app.example.test/api/v1/recorder/config"),
            )
        ).json();
    const first = await getConfig();
    expect(first).toMatchObject({
        encrypted_recording_protocol: 1,
        account: { id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) },
        features: { offlineRecording: 1, roomRecorders: 1 },
        offlineKey: { kid: "viewer-kid" },
    });
    mocks.env.SELF_HOST_MODE = "local";
    mocks.gate.mockResolvedValue({
        authn: { user: { id: scope.userId }, apiKeyId: "new-key" },
    });
    const local = await getConfig();
    expect(local.account).toEqual(first.account);
    expect(local.offlineKey).toEqual(first.offlineKey);
    expect(local.features).toHaveProperty("offlineRecording", 1);
    expect(local.features).not.toHaveProperty("roomRecorders");
    mocks.env.IS_HOSTED = true;
    mocks.env.SELF_HOST_MODE = "shared";
    mocks.gate.mockResolvedValue({
        authn: { user: { id: "another-user" }, apiKeyId: "other-key" },
    });
    const hosted = await getConfig();
    expect(hosted.account).not.toEqual(first.account);
    expect(hosted.offlineKey.kid).toBe("another-user-kid");
    expect(hosted.features).not.toHaveProperty("roomRecorders");
    expect(hosted.features).toHaveProperty("offlineRecording", 1);
});

it("scopes lookup to the authenticated caller and uses the same envelope on a match and a miss", async () => {
    expect(await (await lookup(request(lookupPath, { room }))).json()).toEqual({
        data: [],
        live_until: null,
        freshForMs: 0,
    });
    const liveUntil = "2026-11-28T09:02:00.000Z";
    mocks.query.mockResolvedValueOnce({
        data: [{ name: "Jitka Dvořáková" }],
        live_until: liveUntil,
        freshForMs: 2_000,
    });
    expect(await (await lookup(request(lookupPath, { room }))).json()).toEqual({
        data: [{ name: "Jitka Dvořáková" }],
        live_until: liveUntil,
        freshForMs: 2_000,
    });
    expect(mocks.query).toHaveBeenCalledWith(
        scope.userId,
        recorderRoomKeyFor(room),
    );
});

it.each([
    { room: [room] },
    { rooms: [room] },
    { room, other: room },
    { room: "zoom:123?pwd=secret" },
])("rejects a request without one exact room", async (body) => {
    const response = await lookup(request(lookupPath, body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.query).not.toHaveBeenCalled();
});

it.each([
    "user:viewer",
    "ip:192.0.2.5",
])("uses a shared endpoint budget for %s", async (bucket) => {
    mocks.bucket.mockImplementation(async (identity: string) => ({
        allowed: identity !== `recorder-rooms:${bucket}`,
        limit: 48,
        remaining: 0,
        resetAt: new Date(Date.now() + 30_000),
    }));
    const response = await lookup(request(lookupPath, { room }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(mocks.bucket.mock.calls.map(([identity]) => identity)).toEqual([
        "recorder-rooms:user:viewer",
        "recorder-rooms:ip:192.0.2.5",
    ]);
    expect(mocks.query).not.toHaveBeenCalled();
});

it("uses the recorder auth gate before touching lookup or lease data", async () => {
    mocks.gate.mockResolvedValue({
        response: Response.json(
            { error: "Unauthorized", code: "UNAUTHORIZED" },
            { status: 401 },
        ),
    });
    expect((await lookup(request(lookupPath, { room }))).status).toBe(401);
    expect(
        (await renew(request(leasePath, { room, revision: 1 }), context))
            .status,
    ).toBe(401);
    expect(
        (await end(request(`${leasePath}/end`, { revision: 2 }), context))
            .status,
    ).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.renew).not.toHaveBeenCalled();
    expect(mocks.end).not.toHaveBeenCalled();
});

it("passes only hashed room moves and explicit room clears to the owner-bound transitions", async () => {
    expect(
        (await renew(request(leasePath, { room, revision: 1 }), context))
            .status,
    ).toBe(200);
    expect(
        (await renew(request(leasePath, { room: null, revision: 2 }), context))
            .status,
    ).toBe(200);
    expect(
        (await end(request(`${leasePath}/end`, { revision: 3 }), context))
            .status,
    ).toBe(200);
    expect(mocks.renew).toHaveBeenNthCalledWith(
        1,
        { ...scope, revision: 1 },
        recorderRoomKeyFor(room),
    );
    expect(mocks.renew).toHaveBeenNthCalledWith(
        2,
        { ...scope, revision: 2 },
        null,
    );
    expect(mocks.end).toHaveBeenCalledWith({ ...scope, revision: 3 });
});

it.each([
    ["renew", { revision: -1, room }],
    ["renew", { revision: 1.5, room }],
    ["renew", { revision: 2_147_483_648, room }],
    ["renew", { revision: "1", room }],
    ["renew", { revision: 1, room, other: room }],
    ["renew", { revision: 1 }],
    ["renew", { revision: 1, room: "zoom:123?pwd=secret" }],
    ["end", {}],
    ["end", { revision: -1 }],
    ["end", { revision: 1.5 }],
    ["end", { revision: 1, room }],
])("rejects a malformed %s body %j before any lease transition", async (action, body) => {
    const response =
        action === "renew"
            ? await renew(request(leasePath, body), context)
            : await end(request(`${leasePath}/end`, body), context);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.renew).not.toHaveBeenCalled();
    expect(mocks.end).not.toHaveBeenCalled();
});

it.each([
    "renew",
    "end",
])("rejects an unparseable %s body before any lease transition", async (action) => {
    const raw = (path: string) =>
        new Request(`https://app.example.test${path}`, {
            method: "POST",
            body: "{",
        });

    const response =
        action === "renew"
            ? await renew(raw(leasePath), context)
            : await end(raw(`${leasePath}/end`), context);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.renew).not.toHaveBeenCalled();
    expect(mocks.end).not.toHaveBeenCalled();
});

describe.each(["renew", "end"])("the %s transition", (action) => {
    it.each([
        [null, 404, "NOT_FOUND"],
        [{ apiKeyId: "other-key" }, 403, "FORBIDDEN"],
        [
            { apiKeyId: scope.apiKeyId, status: "completing" },
            409,
            "RECORDING_LEASE_REFUSED",
        ],
        [
            {
                apiKeyId: scope.apiKeyId,
                status: "open",
                leaseEndedAt: new Date(),
            },
            409,
            "RECORDING_LEASE_REFUSED",
        ],
        [
            { apiKeyId: scope.apiKeyId, status: "open", leaseRevision: 4 },
            409,
            "RECORDING_LEASE_REFUSED",
        ],
    ])("reports its refusal (%s)", async (session, status, code) => {
        (action === "renew" ? mocks.renew : mocks.end).mockResolvedValueOnce(
            false,
        );
        mocks.getSession.mockResolvedValueOnce(session);

        const response =
            action === "renew"
                ? await renew(
                      request(leasePath, { room, revision: 1 }),
                      context,
                  )
                : await end(
                      request(`${leasePath}/end`, { revision: 1 }),
                      context,
                  );

        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ code });
        expect(mocks.getSession).toHaveBeenCalledWith(
            scope.sessionId,
            scope.userId,
        );
    });
});
