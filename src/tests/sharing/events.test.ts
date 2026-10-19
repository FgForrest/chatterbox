import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgEvent } from "@/lib/org/events";

const mocks = vi.hoisted(() => ({
    listen: vi.fn(),
    publish: vi.fn(),
    enabled: true,
    org: "org" as string | null,
    orgListeners: new Set<(event: OrgEvent) => void>(),
    payload: null as ((payload: string) => void) | null,
    session: vi.fn(),
}));
vi.mock("@/db", () => ({ sqlClient: { listen: mocks.listen } }));
vi.mock("@/db/queries/events", () => ({ publishEvent: mocks.publish }));
vi.mock("@/lib/mail/config", () => ({ isMailEnabled: () => mocks.enabled }));
vi.mock("@/lib/auth-server", () => ({ requireApiSession: mocks.session }));
vi.mock("@/lib/org/config", () => ({ getOrgUserId: async () => mocks.org }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/org/events", () => ({
    subscribeOrgEvents: (listener: (event: OrgEvent) => void) => {
        mocks.orgListeners.add(listener);
        return () => mocks.orgListeners.delete(listener);
    },
}));

import { GET } from "@/app/api/events/route";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    notifyMailAccepted,
    parsePersonalEvent,
    subscribePersonalEvents,
} from "@/lib/events/personal";
import { parseClientEvent } from "@/lib/events/types";

const aborts: AbortController[] = [];
const unsubscribes: (() => void)[] = [];

beforeEach(() => {
    vi.useFakeTimers();
    mocks.enabled = true;
    mocks.org = "org";
    mocks.publish.mockReset().mockResolvedValue(undefined);
    mocks.listen.mockImplementation(
        async (_channel: string, listener: (payload: string) => void) => {
            mocks.payload = listener;
        },
    );
    mocks.session.mockImplementation(async (request: Request) => ({
        user: { id: request.headers.get("test-user") ?? "a" },
    }));
});
afterEach(() => {
    for (const abort of aborts.splice(0)) abort.abort();
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    expect(mocks.orgListeners.size).toBe(0);
    vi.useRealTimers();
});

function push(userId: string) {
    mocks.payload?.(JSON.stringify({ type: "mail", userId }));
}
async function open(userId: string) {
    const abort = new AbortController();
    aborts.push(abort);
    const response = await GET(
        new Request("http://app/api/events", {
            headers: { "test-user": userId },
            signal: abort.signal,
        }),
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing stream");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        ": connected\n\n",
    );
    return { response, reader, abort };
}
async function read(reader: ReadableStreamDefaultReader<Uint8Array>) {
    return new TextDecoder().decode((await reader.read()).value);
}

describe("event parsing", () => {
    it.each([
        "{",
        "null",
        "[]",
        "1",
        "{}",
        '{"type":"tree"}',
        '{"type":"mail"}',
        '{"type":"mail","userId":1}',
        '{"type":"mail","userId":""}',
        '{"type":"mail","userId":"a","content":"secret"}',
    ])("rejects foreign database payload %s", (payload) => {
        expect(parsePersonalEvent(payload)).toBeNull();
    });
    it("accepts ids only on the database side and no user id on the client", () => {
        expect(parsePersonalEvent('{"type":"mail","userId":"a"}')).toEqual({
            type: "mail",
            userId: "a",
        });
        expect(parseClientEvent('{"type":"mail","userId":"a"}')).toBeNull();
        expect(parseClientEvent('{"type":"mail"}')).toEqual({ type: "mail" });
        expect(
            parseClientEvent('{"type":"recording","recordingId":"r"}'),
        ).toEqual({ type: "recording", recordingId: "r" });
    });
});

describe("personal subscriptions", () => {
    it("filters two viewers in one process and unsubscribes", () => {
        const a = vi.fn();
        const b = vi.fn();
        const stopA = subscribePersonalEvents("a", a);
        unsubscribes.push(stopA, subscribePersonalEvents("b", b));
        push("a");
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).not.toHaveBeenCalled();
        push("b");
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
        stopA();
        push("a");
        expect(a).toHaveBeenCalledTimes(1);
    });
    it("makes notification failures best effort", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        mocks.publish.mockRejectedValueOnce(new Error("offline"));
        await expect(notifyMailAccepted("a")).resolves.toBeUndefined();
        expect(error).toHaveBeenCalledTimes(1);
        error.mockRestore();
    });
});

describe("GET /api/events", () => {
    it("serves personal events without an Organization and sends no identifying data", async () => {
        mocks.org = null;
        const a = await open("a");
        const b = await open("b");
        push("b");
        expect(await read(b.reader)).toBe('data: {"type":"mail"}\n\n');
        push("a");
        expect(await read(a.reader)).toBe('data: {"type":"mail"}\n\n');
        vi.advanceTimersByTime(25_000);
        expect(await read(a.reader)).toBe(": keep-alive\n\n");
        expect(await read(b.reader)).toBe(": keep-alive\n\n");
        expect(mocks.orgListeners.size).toBe(0);
    });
    it("sends org events to every signed-in stream alongside personal events", async () => {
        const a = await open("a");
        const b = await open("b");
        for (const listener of mocks.orgListeners) listener({ type: "tree" });
        expect(await read(a.reader)).toBe('data: {"type":"tree"}\n\n');
        expect(await read(b.reader)).toBe('data: {"type":"tree"}\n\n');
        expect(a.response.headers.get("Content-Type")).toBe(
            "text/event-stream; charset=utf-8",
        );
        expect(a.response.headers.get("Cache-Control")).toBe(
            "no-cache, no-transform",
        );
        expect(a.response.headers.get("Connection")).toBe("keep-alive");
        expect(a.response.headers.get("X-Accel-Buffering")).toBe("no");
    });
    it("ignores mail while disabled and still delivers org changes", async () => {
        mocks.enabled = false;
        const a = await open("a");
        await notifyMailAccepted("a");
        push("a");
        expect(mocks.publish).not.toHaveBeenCalled();
        for (const listener of mocks.orgListeners) listener({ type: "tree" });
        expect(await read(a.reader)).toBe('data: {"type":"tree"}\n\n');
    });
    it("cleans up subscriptions and keepalives on abort and cancel", async () => {
        const a = await open("a");
        const b = await open("b");
        a.abort.abort();
        await b.reader.cancel();
        expect((await a.reader.read()).done).toBe(true);
        expect(mocks.orgListeners.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });
    it("handles an already aborted request", async () => {
        const abort = new AbortController();
        abort.abort();
        const response = await GET(
            new Request("http://app/api/events", { signal: abort.signal }),
        );
        expect(await response.text()).toBe("");
        expect(vi.getTimerCount()).toBe(0);
    });
    it("requires a signed-in session", async () => {
        mocks.session.mockRejectedValueOnce(
            new AppError(ErrorCode.UNAUTHORIZED, "Unauthorized", 401),
        );
        const response = await GET(new Request("http://app/api/events"));
        expect(response.status).toBe(401);
        expect(mocks.orgListeners.size).toBe(0);
    });
});
