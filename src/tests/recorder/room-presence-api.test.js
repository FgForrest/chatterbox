import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
    lookupRoomRecorders,
    postRecordingLease,
} from "../../../extensions/recorder/lib/api.js";

const auth = {
    serverUrl: "https://recorder.example.com",
    connectionId: "current",
    apiKey: "test-recorder-key",
};
const room = "zoom:123456789";
const leasePath = "/api/v1/recording-sessions/example-session/lease";

beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn() } });
});

afterEach(() => vi.unstubAllGlobals());

it("posts one canonical room and keeps only names and response freshness", async () => {
    const liveUntil = "2026-11-28T09:02:00.000Z";
    fetch.mockResolvedValue(
        Response.json({
            live_until: liveUntil,
            freshForMs: 2_000,
            data: [
                { name: "Robin Harper", privateField: "ignored" },
                { name: "" },
            ],
        }),
    );
    expect(await lookupRoomRecorders(auth, room)).toEqual({
        names: ["Robin Harper", ""],
        freshForMs: 2_000,
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
        `${auth.serverUrl}/api/v1/recorder/rooms/recorders`,
        expect.objectContaining({
            method: "POST",
            redirect: "error",
            body: JSON.stringify({ room }),
        }),
    );
    expect(fetch.mock.calls[0][1].headers.get("Authorization")).toBe(
        `Bearer ${auth.apiKey}`,
    );
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});

it("drops names from a room server that only supplies wall-clock expiry", async () => {
    fetch.mockResolvedValue(
        Response.json({
            data: [{ name: "Robin Harper" }],
            live_until: new Date(Date.now() + 30_000).toISOString(),
        }),
    );
    expect(await lookupRoomRecorders(auth, room)).toEqual({
        names: [],
        freshForMs: 0,
    });
});

it("uses distinct wire bodies for renew, clear and end", async () => {
    fetch.mockImplementation(async () => Response.json({ success: true }));
    await postRecordingLease(auth, "example-session", 1, room);
    await postRecordingLease(auth, "example-session", 2, null);
    await postRecordingLease(auth, "example-session", 3);
    expect(
        fetch.mock.calls.map(([url, init]) => [
            url,
            init.method,
            JSON.parse(init.body),
        ]),
    ).toEqual([
        [auth.serverUrl + leasePath, "POST", { revision: 1, room }],
        [auth.serverUrl + leasePath, "POST", { revision: 2, room: null }],
        [`${auth.serverUrl}${leasePath}/end`, "POST", { revision: 3 }],
    ]);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});

it("preserves the terminal lease refusal and Retry-After on a bare 429", async () => {
    fetch
        .mockResolvedValueOnce(
            Response.json(
                { code: "RECORDING_LEASE_REFUSED", error: "Ended" },
                { status: 409 },
            ),
        )
        .mockResolvedValueOnce(
            new Response(null, {
                status: 429,
                headers: { "Retry-After": "60" },
            }),
        );
    await expect(
        postRecordingLease(auth, "example-session", 1, room),
    ).rejects.toMatchObject({
        code: "RECORDING_LEASE_REFUSED",
    });
    await expect(lookupRoomRecorders(auth, room)).rejects.toMatchObject({
        httpStatus: 429,
        retryAfterSeconds: 60,
    });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});

it("keeps network failures and invalid lookup responses out of connection notices", async () => {
    fetch
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce(
            Response.json({ data: [{ id: "without-name" }] }),
        );
    await expect(
        postRecordingLease(auth, "example-session", 1, room),
    ).rejects.toThrow();
    await expect(lookupRoomRecorders(auth, room)).rejects.toThrow();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});
