// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type { TranslationValues } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    AgendaBody,
    type AgendaVariant,
} from "@/components/meetings/agenda-body";
import { MeetingRow } from "@/components/meetings/meeting-row";
import type { MeetingDetail } from "@/components/meetings/types";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import { at, detail, point, row, task } from "./ui-fixtures";

const { toastError, replace } = vi.hoisted(() => ({
    toastError: vi.fn(),
    replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("next-intl", () => ({
    useExtracted: () => (text: string, values?: TranslationValues) =>
        translatedSourceMessage("en", text, values),
    useLocale: () => "en",
    useFormatter: () => ({
        dateTime: (value: Date) => value.toISOString().slice(0, 16),
    }),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock("@/components/tasks/task-row", () => ({
    TaskRow: ({
        task,
        actions,
    }: {
        task: { text: string; note: string | null };
        actions?: ReactNode;
    }) => (
        <li>
            <p>{task.text}</p>
            {task.note && <p>{task.note}</p>}
            {actions}
        </li>
    ),
}));
let server: MeetingDetail;
const fetchMock = vi.fn();
beforeEach(() => {
    server = detail();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
            const body = JSON.parse(String(init.body));
            if (url.includes("/api/tasks/"))
                server = {
                    ...server,
                    version: server.version + 1,
                    tasks: server.tasks.map((entry) => ({
                        ...entry,
                        status: body.status ?? entry.status,
                    })),
                };
            else if (url.includes("/points/"))
                server = {
                    ...server,
                    version: server.version + 1,
                    points: server.points.map((entry) => ({
                        ...entry,
                        ...(body.discussed !== undefined
                            ? { discussedAt: body.discussed ? at : null }
                            : {}),
                        ...(body.note !== undefined ? { note: body.note } : {}),
                        version: entry.version + 1,
                    })),
                };
            else
                server = {
                    ...server,
                    state: body.state ?? server.state,
                    version: server.version + 1,
                };
            return Response.json({ success: true });
        }
        if (url.endsWith("/suggestions"))
            return Response.json(
                {
                    error: "Agenda suggestions are not available yet",
                    code: "CONFLICT",
                },
                { status: 409 },
            );
        return Response.json(server);
    });
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

it.each([
    ["planned", "Preparing"],
    ["live", "In progress"],
    ["held", "Without recording"],
] as const)("renders the %s row state and opens the agenda", (state, label) => {
    const onSelect = vi.fn();
    render(
        <MeetingRow meeting={row({ state })} selected onSelect={onSelect} />,
    );
    expect(screen.getByText(label)).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith("agenda");
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe(
        "true",
    );
});

describe.each([
    "meeting",
    "live",
    "recording",
] as const)("shared agenda body: %s", (variant: AgendaVariant) => {
    async function mount() {
        server = detail({
            state: variant === "live" ? "live" : "planned",
            liveStartedAt: variant === "live" ? at : null,
            ...(variant === "recording"
                ? {
                      recordingItemId: "recording",
                      permissions: { view: true, edit: false, manage: false },
                  }
                : {}),
            invitees: [{ name: "Jitka Dvořáková" }, { name: "Dana Nováková" }],
            tasks: [
                task("Other task", "Alex Example"),
                task("Unassigned task", null),
                task("Invited task", "Jitka Dvořáková", {
                    note: "Assignee update",
                }),
            ],
            points: [point("Discuss this")],
        });
        const view = render(
            <AgendaBody
                id="agenda"
                variant={variant}
                initial={server}
                userId="owner"
            />,
        );
        await act(async () => {});
        if (variant === "recording")
            fireEvent.click(screen.getByRole("button", { name: /Agenda/ }));
        return view;
    }
    it("groups invitees first, other assignees next and unassigned last; shows taskless invitees", async () => {
        await mount();
        const names = screen
            .getAllByRole("heading", { level: 3 })
            .map((element) => element.textContent);
        expect(names[0]).toContain("Jitka Dvořáková");
        expect(names[1]).toContain("Alex Example");
        expect(names[1]).toContain("Not invited");
        expect(names[2]).toContain("No assignee");
        expect(
            screen.getByText("Invitees without tasks: Dana Nováková"),
        ).toBeTruthy();
        expect(screen.getByText("Assignee update")).toBeTruthy();
    });
    it("keeps read-only controls out of the recording variant and offers correct live/preparation actions", async () => {
        await mount();
        if (variant === "recording") {
            expect(
                screen.queryByRole("button", { name: "Start meeting" }),
            ).toBeNull();
            expect(
                screen.queryByRole("button", { name: /Remove .* from agenda/ }),
            ).toBeNull();
            expect(screen.queryByLabelText("Discussion point")).toBeNull();
            expect(
                screen.getByLabelText("Discussed: Discuss this"),
            ).toHaveProperty("disabled", true);
        } else if (variant === "live") {
            expect(
                screen.getByRole("button", { name: "End meeting" }),
            ).toBeTruthy();
            await act(async () =>
                fireEvent.click(
                    screen.getByLabelText("Discussed: Discuss this"),
                ),
            );
            await waitFor(() =>
                expect(
                    screen.getByLabelText("Discussed: Discuss this"),
                ).toHaveProperty("checked", true),
            );
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining("/points/Discuss%20this"),
                expect.objectContaining({
                    method: "PATCH",
                    body: expect.stringContaining('"discussed":true'),
                }),
            );
        } else {
            await act(async () =>
                fireEvent.click(
                    screen.getByRole("button", { name: "Start meeting" }),
                ),
            );
            await waitFor(() =>
                expect(
                    screen.getByRole("button", { name: "End meeting" }),
                ).toBeTruthy(),
            );
        }
    });
    it("uses task permissions for quick Done and the existing task route", async () => {
        await mount();
        if (variant !== "live") {
            expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
            return;
        }
        await act(async () =>
            fireEvent.click(screen.getAllByRole("button", { name: "Done" })[0]),
        );
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining("/api/tasks/"),
            expect.objectContaining({
                method: "PATCH",
                body: expect.stringContaining('"status":"done"'),
            }),
        );
    });
});
it("shows the server's unavailable AI suggestions error as a toast", async () => {
    render(<AgendaBody id="agenda" initial={server} userId="owner" />);
    await act(async () => {});
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Suggest points" })),
    );
    expect(toastError).toHaveBeenCalledWith(
        "Agenda suggestions are not available yet",
    );
});
it("does not let a non-manager start or end a meeting", async () => {
    server = detail({ permissions: { view: true, edit: true, manage: false } });
    render(<AgendaBody id="agenda" initial={server} userId="other" />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Start meeting" })).toBeNull();
});
