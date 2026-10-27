// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MeetingDetail } from "@/components/meetings/types";
import { useAgenda } from "@/components/meetings/use-agenda";
import { detail, point } from "./ui-fixtures";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("next-intl", () => ({ useExtracted: () => (text: string) => text }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));
let server: MeetingDetail;
const fetchMock = vi.fn();
function Harness({ active = true }: { active?: boolean }) {
    const state = useAgenda("agenda", detail(), active);
    return (
        <>
            <output data-testid="content">
                {state.detail?.points.map((entry) => entry.text).join("/")} v
                {state.detail?.version}
            </output>
            <span>{state.colleagueChange ? "Changed" : "Quiet"}</span>
            <button
                type="button"
                onClick={() =>
                    void state.mutate(
                        "/points/First%20point",
                        "PATCH",
                        (value: MeetingDetail) => ({
                            text: "Local edit",
                            version: value.points[0].version,
                        }),
                        (value) => ({
                            ...value,
                            points: value.points.map((entry) => ({
                                ...entry,
                                text: "Local edit",
                            })),
                        }),
                    )
                }
            >
                Edit
            </button>
        </>
    );
}
beforeEach(() => {
    vi.useFakeTimers();
    server = detail();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) =>
        Response.json(
            url.includes("since=1") && server.version === 1
                ? { unchanged: true, version: 1 }
                : server,
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
it("polls every 15 seconds with the version cursor, applies remote changes and honors unchanged responses", async () => {
    render(<Harness />);
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/meetings/agenda?since=1",
        expect.any(Object),
    );
    expect(screen.getByText("Quiet")).toBeTruthy();
    server = detail({ version: 2, points: [point("Remote change")] });
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(screen.getByTestId("content").textContent).toBe("Remote change v2");
    expect(screen.getByText("Changed")).toBeTruthy();
});
it("does not poll a hidden document or inactive pane", async () => {
    const { rerender } = render(<Harness />);
    await act(async () => {});
    fetchMock.mockClear();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => vi.advanceTimersByTimeAsync(30000));
    expect(fetchMock).not.toHaveBeenCalled();
    rerender(<Harness active={false} />);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => vi.advanceTimersByTimeAsync(30000));
    expect(fetchMock).not.toHaveBeenCalled();
});
it("never overwrites an optimistic edit with a poll started before the write", async () => {
    render(<Harness />);
    await act(async () => {});
    let resolvePoll: (value: Response) => void = () => {};
    let resolveWrite: (value: Response) => void = () => {};
    let delayedPoll = false;
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
        if (init.method === "PATCH")
            return new Promise<Response>((resolve) => {
                resolveWrite = resolve;
            });
        if (url.includes("since=") && !delayedPoll) {
            delayedPoll = true;
            return new Promise<Response>((resolve) => {
                resolvePoll = resolve;
            });
        }
        return Promise.resolve(Response.json(server));
    });
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Edit" })),
    );
    expect(screen.getByTestId("content").textContent).toContain("Local edit");
    await act(async () =>
        resolvePoll(
            Response.json(
                detail({ version: 2, points: [point("Stale remote")] }),
            ),
        ),
    );
    expect(screen.getByTestId("content").textContent).toContain("Local edit");
    server = detail({
        version: 3,
        points: [point("Local edit", { version: 1 })],
    });
    await act(async () => resolveWrite(Response.json(server.points[0])));
    expect(screen.getByTestId("content").textContent).toBe("Local edit v3");
});
it("rolls back refused writes and reads the conflict's current point", async () => {
    render(<Harness />);
    await act(async () => {});
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
        init.method === "PATCH"
            ? Response.json(
                  { error: "Agenda point changed", code: "CONFLICT" },
                  { status: 409 },
              )
            : Response.json(server),
    );
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Edit" })),
    );
    expect(screen.getByTestId("content").textContent).toBe("First point v1");
    expect(toastError).toHaveBeenCalledWith("Agenda point changed");
});
