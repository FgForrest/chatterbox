import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@/db/queries/agenda-listener", () => ({
    openAgendaListener: mocks.listen,
}));

import { parseAgendaEvent, subscribeAgendaEvents } from "@/lib/meetings/events";

afterEach(() => {
    vi.clearAllMocks();
});

describe("agenda event fan-out", () => {
    it("rejects content-bearing or malformed notifications", () => {
        expect(parseAgendaEvent('{"agendaId":"agenda","cursor":"3"}')).toEqual({
            agendaId: "agenda",
            cursor: "3",
        });
        for (const value of [
            null,
            [],
            {},
            { agendaId: "agenda", cursor: "3", text: "private" },
            { agendaId: "", cursor: "3" },
            { agendaId: "agenda", cursor: "text" },
        ])
            expect(parseAgendaEvent(JSON.stringify(value))).toBeNull();
        expect(parseAgendaEvent("not JSON")).toBeNull();
    });
    it("uses one LISTEN, delivers only to the matching agenda, and unsubscribes", () => {
        mocks.listen.mockResolvedValue(() => {});
        const a = vi.fn();
        const b = vi.fn();
        const stopA = subscribeAgendaEvents("a", a);
        const stopB = subscribeAgendaEvents("b", b);
        expect(mocks.listen).toHaveBeenCalledTimes(1);
        const receive = mocks.listen.mock.calls[0][0] as (
            value: string,
        ) => void;
        receive('{"agendaId":"a","cursor":"4"}');
        expect(a).toHaveBeenCalledWith({ agendaId: "a", cursor: "4" });
        expect(b).not.toHaveBeenCalled();
        stopA();
        receive('{"agendaId":"a","cursor":"5"}');
        expect(a).toHaveBeenCalledTimes(1);
        stopB();
    });
});

it("waits for LISTEN readiness, closes all affected streams on failure, and backs off for later subscribers", async () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const ready = vi.fn();
    let rejectListen: (error: Error) => void = () => {};
    mocks.listen.mockImplementationOnce(
        () =>
            new Promise((_resolve, reject) => {
                rejectListen = reject;
            }),
    );
    const stop = subscribeAgendaEvents("x", vi.fn(), { ready, failed: fail });
    expect(ready).not.toHaveBeenCalled();
    rejectListen(new Error("offline"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fail).toHaveBeenCalledOnce();
    stop();
    const nextReady = vi.fn();
    mocks.listen.mockResolvedValue(() => {});
    const later = subscribeAgendaEvents("y", vi.fn(), {
        ready: nextReady,
        failed: vi.fn(),
    });
    const calls = mocks.listen.mock.calls.length;
    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.listen).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(1);
    expect(nextReady).toHaveBeenCalledOnce();
    later();
    vi.useRealTimers();
});

it("closes every subscriber after an established listener fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 60000));
    const readyA = vi.fn();
    const readyB = vi.fn();
    const failedA = vi.fn();
    const failedB = vi.fn();
    mocks.listen.mockResolvedValue(() => {});
    const stopA = subscribeAgendaEvents("runtime-a", vi.fn(), {
        ready: readyA,
        failed: failedA,
    });
    const stopB = subscribeAgendaEvents("runtime-b", vi.fn(), {
        ready: readyB,
        failed: failedB,
    });
    await Promise.resolve();
    expect(readyA).toHaveBeenCalledOnce();
    expect(readyB).toHaveBeenCalledOnce();
    const failed = mocks.listen.mock.calls.at(-1)?.[1] as () => void;
    failed();
    expect(failedA).toHaveBeenCalledOnce();
    expect(failedB).toHaveBeenCalledOnce();
    stopA();
    stopB();
    vi.useRealTimers();
});
