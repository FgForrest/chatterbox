import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    access: vi.fn(),
    claim: vi.fn(),
    renew: vi.fn(),
    release: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    gate: vi.fn(),
    session: vi.fn(),
}));
vi.mock("@/db/queries/agenda-events", () => ({
    claimAgendaStream: mocks.claim,
    renewAgendaStream: mocks.renew,
    releaseAgendaStream: mocks.release,
}));
vi.mock("@/lib/meetings/access", () => ({
    requireMeetingAccess: mocks.access,
}));
vi.mock("@/lib/meetings/events", () => ({
    subscribeAgendaEvents: mocks.subscribe,
}));
vi.mock("@/lib/auth-server", () => ({ requireApiSession: mocks.session }));
vi.mock("@/lib/recording-sessions/route-gate", () => ({
    gateRecordingSessionRequest: mocks.gate,
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));

import { GET as web } from "@/app/api/meetings/[id]/events/route";
import { GET as recorder } from "@/app/api/v1/recorder/agendas/[id]/events/route";
import { AppError, ErrorCode } from "@/lib/errors";

beforeEach(() => {
    vi.useFakeTimers();
    mocks.access.mockResolvedValue({ agenda: { id: "agenda" } });
    mocks.claim.mockResolvedValue("lease");
    mocks.renew.mockResolvedValue(true);
    mocks.release.mockResolvedValue(undefined);
    mocks.subscribe.mockImplementation((_id, _receive, lifecycle) => {
        queueMicrotask(() => lifecycle.ready());
        return mocks.unsubscribe;
    });
    mocks.gate.mockResolvedValue({ authn: { user: { id: "viewer" } } });
    mocks.session.mockResolvedValue({ user: { id: "viewer" } });
});
afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
});

describe.each([web, recorder])("agenda SSE routes", (handler) => {
    const context = { params: Promise.resolve({ id: "agenda" }) };
    it("checks visibility before claiming capacity", async () => {
        mocks.access.mockRejectedValue(
            new AppError(ErrorCode.NOT_FOUND, "Meeting not found", 404),
        );
        const response = await handler(
            new Request("https://example.com/events"),
            context,
        );
        expect(response.status).toBe(404);
        expect(mocks.claim).not.toHaveBeenCalled();
    });
    it("returns 429 above the shared per-user stream cap", async () => {
        mocks.claim.mockResolvedValue(null);
        const response = await handler(
            new Request("https://example.com/events"),
            context,
        );
        expect(response.status).toBe(429);
        expect(mocks.subscribe).not.toHaveBeenCalled();
    });
    it("frames ID-free invalidations, keeps alive, rechecks access and releases on abort", async () => {
        const abort = new AbortController();
        const response = await handler(
            new Request("https://example.com/events", { signal: abort.signal }),
            context,
        );
        expect(response.headers.get("content-type")).toContain(
            "text/event-stream",
        );
        expect(mocks.access).toHaveBeenCalledWith("viewer", "agenda");
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        expect(decoder.decode((await reader?.read())?.value)).toBe(
            ": connected\n\nevent: connected\ndata: {}\n\n",
        );
        const listener = mocks.subscribe.mock.calls[0][1] as (event: {
            agendaId: string;
            cursor: string;
        }) => void;
        listener({ agendaId: "agenda", cursor: "7" });
        expect(decoder.decode((await reader?.read())?.value)).toBe(
            'data: {"type":"agenda","cursor":"7"}\n\n',
        );
        await vi.advanceTimersByTimeAsync(25000);
        expect(decoder.decode((await reader?.read())?.value)).toBe(
            ": keep-alive\n\n",
        );
        expect(mocks.renew).toHaveBeenCalledWith("viewer", "lease");
        abort.abort();
        expect((await reader?.read())?.done).toBe(true);
        expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
        expect(mocks.release).toHaveBeenCalledWith("viewer", "lease");
    });
    it("closes a stream when access is revoked or its lease expires", async () => {
        const response = await handler(
            new Request("https://example.com/events"),
            context,
        );
        const reader = response.body?.getReader();
        await reader?.read();
        mocks.access.mockRejectedValue(
            new AppError(ErrorCode.NOT_FOUND, "Meeting not found", 404),
        );
        await vi.advanceTimersByTimeAsync(25000);
        expect((await reader?.read())?.done).toBe(true);
        expect(mocks.release).toHaveBeenCalledTimes(1);
    });
    it("waits for LISTEN before announcing readiness and closes on listener failure", async () => {
        mocks.subscribe.mockReturnValue(mocks.unsubscribe);
        const response = await handler(
            new Request("https://example.com/events"),
            context,
        );
        const reader = response.body?.getReader();
        let resolved = false;
        const first = reader?.read().then((chunk) => {
            resolved = true;
            return chunk;
        });
        await Promise.resolve();
        expect(resolved).toBe(false);
        const lifecycle = mocks.subscribe.mock.calls[0][2] as {
            ready: () => void;
            failed: () => void;
        };
        lifecycle.ready();
        expect(new TextDecoder().decode((await first)?.value)).toBe(
            ": connected\n\nevent: connected\ndata: {}\n\n",
        );
        lifecycle.failed();
        expect((await reader?.read())?.done).toBe(true);
        expect(mocks.release).toHaveBeenCalledOnce();
    });
    it("cleans up a request that was already aborted", async () => {
        const abort = new AbortController();
        abort.abort();
        const response = await handler(
            new Request("https://example.com/events", { signal: abort.signal }),
            context,
        );
        expect((await response.body?.getReader().read())?.done).toBe(true);
        expect(mocks.release).toHaveBeenCalledTimes(1);
    });
});

it("rechecks recorder credentials without consuming rate limits and closes on revocation", async () => {
    const abort = new AbortController();
    const request = new Request("https://example.com/events", {
        signal: abort.signal,
    });
    const response = await recorder(request, {
        params: Promise.resolve({ id: "agenda" }),
    });
    const reader = response.body?.getReader();
    await reader?.read();
    mocks.gate.mockImplementation(async (_request, options) =>
        options?.rateLimit === false
            ? { authn: { user: { id: "viewer" } } }
            : { response: Response.json({}, { status: 429 }) },
    );
    await vi.advanceTimersByTimeAsync(25000);
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe(
        ": keep-alive\n\n",
    );
    expect(mocks.gate).toHaveBeenLastCalledWith(request, { rateLimit: false });
    mocks.gate.mockRejectedValue(new Error("revoked"));
    await vi.advanceTimersByTimeAsync(25000);
    expect((await reader?.read())?.done).toBe(true);
    abort.abort();
});
