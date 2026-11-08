import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    query: vi.fn(),
    end: vi.fn(),
    options: {
        onclose: () => {},
        onnotify: (_channel: string, _payload: string) => {},
    },
}));
vi.mock("@/lib/env", () => ({
    env: { DATABASE_URL: "postgres://localhost/fixture" },
}));
vi.mock("postgres", () => ({
    default: (_url: string, options: typeof mocks.options) => {
        mocks.options = options;
        return Object.assign(mocks.query, { end: mocks.end });
    },
}));

import { openAgendaListener } from "@/db/queries/agenda-listener";

beforeEach(() => {
    mocks.query.mockReset().mockResolvedValue([]);
    mocks.end.mockReset().mockResolvedValue(undefined);
});

it("waits for LISTEN, forwards only its channel and closes subscribers on connection loss", async () => {
    const receive = vi.fn();
    const failed = vi.fn();
    const stop = await openAgendaListener(receive, failed);
    expect(mocks.query.mock.calls[0][0]).toEqual(["LISTEN riffado_agenda"]);
    mocks.options.onnotify("another", "ignored");
    mocks.options.onnotify("riffado_agenda", "event");
    expect(receive).toHaveBeenCalledExactlyOnceWith("event");
    mocks.options.onclose();
    expect(failed).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
    stop();
    mocks.options.onclose();
    expect(failed).toHaveBeenCalledOnce();
});
it("rejects an initial LISTEN failure and disposes its connection", async () => {
    mocks.query.mockRejectedValue(new Error("offline"));
    await expect(openAgendaListener(vi.fn(), vi.fn())).rejects.toThrow(
        "offline",
    );
    expect(mocks.end).toHaveBeenCalledOnce();
});
