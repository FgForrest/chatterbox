// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type { TranslationValues } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgendaBody } from "@/components/meetings/agenda-body";
import { MeetingSettings } from "@/components/meetings/meeting-settings";
import type { MeetingDetail } from "@/components/meetings/types";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import { at, detail, point, task } from "./ui-fixtures";

const mocks = vi.hoisted(() => ({
    error: vi.fn(),
    locale: "en" as "en" | "cs-CZ",
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("next-intl", () => ({
    useExtracted: () => (message: string, values?: TranslationValues) =>
        translatedSourceMessage(mocks.locale, message, values),
    useLocale: () => mocks.locale,
    useFormatter: () => ({ dateTime: (date: Date) => date.toISOString() }),
}));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));
vi.mock("@/components/tasks/task-row", () => ({
    TaskRow: ({ actions }: { actions: ReactNode }) => <li>{actions}</li>,
}));
const fetchMock = vi.fn();
let server: MeetingDetail;
beforeEach(() => {
    mocks.locale = "en";
    mocks.error.mockReset();
    server = detail({ cursor: "1:standalone:idle" });
    fetchMock.mockReset().mockImplementation(async () => Response.json(server));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe.each([
    "meeting",
    "live",
    "recording",
] as const)("review behavior: %s", (variant) => {
    function mount() {
        return render(
            <AgendaBody
                id="agenda"
                initial={server}
                variant={variant}
                userId="owner"
            />,
        );
    }
    it("polls an opaque cursor and displays completed suggestions through refresh, with no recording polls", async () => {
        vi.useFakeTimers();
        server = detail({
            cursor: "1:standalone:queued",
            aiSuggestions: {
                available: true,
                reason: null,
                job: { state: "queued" },
            },
        });
        mount();
        if (variant === "recording") {
            await act(async () => vi.advanceTimersByTimeAsync(60000));
            expect(fetchMock).not.toHaveBeenCalled();
            return;
        }
        expect(screen.getByText("Suggestions queued…")).toBeTruthy();
        server = {
            ...server,
            cursor: "1:standalone:running",
            aiSuggestions: {
                available: true,
                reason: null,
                job: { state: "running" },
            },
        };
        await act(async () => vi.advanceTimersByTimeAsync(15000));
        expect(fetchMock).toHaveBeenLastCalledWith(
            "/api/meetings/agenda?since=1%3Astandalone%3Aqueued",
            expect.any(Object),
        );
        expect(screen.getByText("Suggesting points…")).toBeTruthy();
        server = {
            ...server,
            version: 2,
            cursor: "2:standalone:idle",
            aiSuggestions: {
                available: true,
                reason: null,
                job: { state: null },
            },
            suggestions: [
                {
                    id: "suggestion",
                    agendaId: "agenda",
                    userId: "owner",
                    text: "New suggestion",
                    kind: "ai",
                    state: "open",
                    parentPointId: null,
                    originPointId: null,
                    createdByUserId: "owner",
                    sources: { itemIds: [], taskIds: [] },
                    createdAt: at,
                    updatedAt: at,
                },
            ],
        };
        await act(async () => vi.advanceTimersByTimeAsync(15000));
        expect(screen.queryByText("Suggesting points…")).toBeNull();
        if (variant === "meeting")
            expect(screen.getByText("New suggestion")).toBeTruthy();
    });
    it("keeps the editing version across a poll and retains refused text with a localized notice", async () => {
        if (variant === "recording") {
            mount();
            expect(screen.queryByLabelText("Discussion point")).toBeNull();
            return;
        }
        vi.useFakeTimers();
        mocks.locale = "cs-CZ";
        mount();
        const field = screen.getByLabelText("Bod k projednání");
        act(() => field.focus());
        fireEvent.change(field, { target: { value: "Moje změna" } });
        server = {
            ...server,
            version: 2,
            cursor: "2:standalone:idle",
            points: [point("First point", { text: "Cizí změna", version: 3 })],
        };
        await act(async () => vi.advanceTimersByTimeAsync(15000));
        fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
            init.method === "PATCH"
                ? Response.json(
                      { code: "CONFLICT", error: "Agenda point changed" },
                      { status: 409 },
                  )
                : Response.json(server),
        );
        await act(async () => field.blur());
        const write = fetchMock.mock.calls.find(
            ([, init]) => init.method === "PATCH",
        );
        expect(JSON.parse(String(write?.[1].body))).toEqual({
            text: "Moje změna",
            version: 0,
        });
        expect(field).toHaveProperty("value", "Moje změna");
        expect(mocks.error).toHaveBeenCalledWith(
            translatedSourceMessage(
                "cs-CZ",
                "Someone else changed this agenda. Your input is kept. Review their changes and try again.",
            ),
        );
        expect(mocks.error).not.toHaveBeenCalledWith("Agenda point changed");
    });
    it("uses idempotent start/end actions without an agenda version", async () => {
        mount();
        if (variant === "recording") {
            expect(
                screen.queryByRole("button", {
                    name: /Start meeting|End meeting/,
                }),
            ).toBeNull();
            return;
        }
        await act(async () =>
            fireEvent.click(
                screen.getByRole("button", {
                    name: variant === "live" ? "End meeting" : "Start meeting",
                }),
            ),
        );
        const write = fetchMock.mock.calls.find(
            ([, init]) => init.method === "PATCH",
        );
        expect(JSON.parse(String(write?.[1].body))).toEqual({
            state: variant === "live" ? "held" : "live",
        });
    });
    it("shows failed jobs with retry and dismisses suggestions in one request", async () => {
        server = {
            ...server,
            aiSuggestions: {
                available: true,
                reason: null,
                job: { state: "failed", errorCode: "AI_PROVIDER_API_ERROR" },
            },
            suggestions: ["one", "two"].map((id) => ({
                id,
                agendaId: "agenda",
                userId: "owner",
                text: id,
                kind: "ai",
                state: "open",
                parentPointId: null,
                originPointId: null,
                createdByUserId: "owner",
                sources: { itemIds: [], taskIds: [] },
                createdAt: at,
                updatedAt: at,
            })),
        };
        mount();
        if (variant === "recording") {
            expect(
                screen.queryByRole("button", { name: "Try again" }),
            ).toBeNull();
            return;
        }
        expect(
            screen.getByText(
                "The provider returned invalid agenda suggestions. Try again.",
            ),
        ).toBeTruthy();
        await act(async () =>
            fireEvent.click(screen.getByRole("button", { name: "Try again" })),
        );
        expect(
            fetchMock.mock.calls.filter(([, init]) => init.method === "POST"),
        ).toHaveLength(1);
        if (variant === "meeting") {
            fetchMock.mockClear();
            await act(async () =>
                fireEvent.click(
                    screen.getByRole("button", { name: "Dismiss all" }),
                ),
            );
            const writes = fetchMock.mock.calls.filter(
                ([, init]) => init.method === "PATCH",
            );
            expect(writes).toHaveLength(1);
            expect(writes[0][0]).toBe("/api/meetings/agenda/suggestions");
            expect(JSON.parse(String(writes[0][1].body))).toEqual({
                state: "dismissed",
                kind: "ai",
            });
        }
    });
});

it("settings preserve all input and the initial previous values through refresh and a conflict", async () => {
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    fetchMock.mockResolvedValue(
        Response.json({ reason: null, recurring: [], other: [] }),
    );
    const { rerender } = render(
        <MeetingSettings detail={server} onSave={save} onDelete={vi.fn()} />,
    );
    await act(async () =>
        fireEvent.click(
            screen.getByRole("button", { name: "Meeting settings" }),
        ),
    );
    fireEvent.change(screen.getByLabelText("Title"), {
        target: { value: "My title" },
    });
    fireEvent.change(screen.getByLabelText("Start (optional)"), {
        target: { value: "2026-11-04T12:30" },
    });
    fireEvent.change(screen.getByLabelText("End (optional)"), {
        target: { value: "2026-11-04T13:30" },
    });
    server = {
        ...server,
        version: 8,
        title: "Their title",
        calendarEventId: "event",
    };
    rerender(
        <MeetingSettings detail={server} onSave={save} onDelete={vi.fn()} />,
    );
    expect(screen.getByLabelText("Title")).toHaveProperty("value", "My title");
    expect(screen.getByLabelText("Start (optional)")).toHaveProperty(
        "value",
        "2026-11-04T12:30",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Save" })),
    );
    expect(save.mock.calls[0][0]).toEqual({
        title: "My title",
        start: "2026-11-04T12:30:00.000Z",
        end: "2026-11-04T13:30:00.000Z",
        previous: {
            title: "Acme planning",
            start: at,
            end: "2026-11-03T11:00:00.000Z",
        },
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
        "Your input is kept",
    );
    expect(screen.getByLabelText("Title")).toHaveProperty("value", "My title");
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Save" })),
    );
    expect(save.mock.calls[1][0].previous.title).toBe("Their title");
    expect(screen.queryByRole("dialog")).toBeNull();
});

it("task source sends its previous field and task notes respect composition", async () => {
    server = detail({ state: "live", tasks: [task("Follow up", null)] });
    render(
        <AgendaBody
            id="agenda"
            initial={server}
            userId="owner"
            recordings={[
                {
                    id: "source",
                    filename: "Previous",
                    startTime: at,
                    duration: 0,
                    filesize: 0,
                    deviceSn: "test",
                },
            ]}
        />,
    );
    await act(async () =>
        fireEvent.change(screen.getByLabelText("Task source"), {
            target: { value: "source" },
        }),
    );
    expect(
        JSON.parse(
            String(
                fetchMock.mock.calls.find(
                    ([, init]) => init.method === "PATCH",
                )?.[1].body,
            ),
        ),
    ).toEqual({
        taskSourceItemId: "source",
        previous: { taskSourceItemId: null },
    });
    const note = screen.getByLabelText("Meeting note for Follow up");
    act(() => note.focus());
    fireEvent.change(note, { target: { value: "New note" } });
    fetchMock.mockClear();
    fireEvent.keyDown(note, { key: "Enter", isComposing: true });
    expect(document.activeElement).toBe(note);
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => fireEvent.keyDown(note, { key: "Enter" }));
    expect(fetchMock).toHaveBeenCalledWith(
        "/api/meetings/agenda/tasks/Follow%20up",
        expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ note: "New note" }),
        }),
    );
});

it("settings retry uses the confirmed server baseline and never patches untouched metadata", async () => {
    const requests: Record<string, unknown>[] = [];
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
        if (url.includes("calendar-events"))
            return Response.json({ reason: null, recurring: [], other: [] });
        if (init.method === "PATCH") {
            requests.push(
                JSON.parse(String(init.body)) as Record<string, unknown>,
            );
            if (requests.length === 1) {
                server = {
                    ...server,
                    title: "Their title",
                    calendarEventId: "their-event",
                    version: 2,
                    cursor: "2:standalone:idle",
                };
                return Response.json(
                    { code: "CONFLICT", error: "Meeting changed" },
                    { status: 409 },
                );
            }
            server = {
                ...server,
                title: "My title",
                version: 3,
                cursor: "3:standalone:idle",
            };
            return Response.json({ success: true });
        }
        return Response.json(server);
    });
    render(<AgendaBody id="agenda" initial={server} userId="owner" />);
    await act(async () =>
        fireEvent.click(
            screen.getByRole("button", { name: "Meeting settings" }),
        ),
    );
    fireEvent.change(screen.getByLabelText("Title"), {
        target: { value: "My title" },
    });
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Save" })),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText("Title")).toHaveProperty("value", "My title");
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Save" })),
    );
    expect(requests).toEqual([
        { title: "My title", previous: { title: "Acme planning" } },
        { title: "My title", previous: { title: "Their title" } },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
});
