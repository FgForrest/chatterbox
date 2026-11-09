// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    within,
} from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { AgendaBody } from "@/components/meetings/agenda-body";
import { RecordingAgenda } from "@/components/meetings/recording-agenda";
import type { MeetingDetail } from "@/components/meetings/types";
import { PersonSharingProvider } from "@/components/sharing/person-sharing";
import { TaskRow } from "@/components/tasks/task-row";
import { at, detail, point, task } from "./ui-fixtures";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/meetings/use-agenda", () => ({
    useAgenda: (_id: string, initial: MeetingDetail) => ({
        detail: initial,
        mutate: vi.fn(),
        pending: 0,
        pendingPaths: [],
    }),
}));
const recording = {
    id: "recording",
    filename: "Acme review",
    duration: 60000,
    filesize: 1,
    startTime: at,
    deviceSn: "local",
    hasAgenda: true,
};
const attached = detail({
    recordingItemId: "recording",
    title: "Recording title",
    agendaTitle: "Acme plan",
    points: [
        point("Handled point", { discussedAt: at }),
        point("Open point", { position: 1 }),
    ],
    tasks: [
        task("Handled task", null, { status: "done" }),
        task("Open task", null, { position: 1 }),
    ],
});
const request = vi.fn();
beforeEach(() => {
    window.localStorage.clear();
    request
        .mockReset()
        .mockImplementation(async (url: string) =>
            Response.json(
                url.endsWith("/agenda")
                    ? { agenda: attached }
                    : url.includes("/recording-shares")
                      ? { people: [{ id: "receiver", name: "Martin Král" }] }
                      : { event: null },
            ),
        );
    vi.stubGlobal("fetch", request);
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});
function frame(children: ReactNode, sharing = true) {
    return (
        <NextIntlClientProvider locale="en" timeZone="UTC">
            <PersonSharingProvider value={sharing}>
                <ConfirmDialogProvider>{children}</ConfirmDialogProvider>
            </PersonSharingProvider>
        </NextIntlClientProvider>
    );
}
function mount(overrides = {}) {
    const changed = vi.fn();
    return {
        ...render(
            frame(
                <RecordingAgenda
                    recording={{ ...recording, ...overrides }}
                    folders={[]}
                    userId="owner"
                    onChanged={changed}
                />,
            ),
        ),
        changed,
    };
}
describe("attached agenda block", () => {
    it("starts collapsed with neutral facts, expands into two plain sections and keeps the share offer", async () => {
        const { container } = mount();
        const expand = await screen.findByRole("button", {
            name: "Expand agenda",
        });
        const line = expand.closest("[data-workflow-widget-line]");
        expect(line?.textContent).toContain(
            "Acme plan · 1 of 2 points discussed · 2 tasks",
        );
        expect(line?.getAttribute("data-tone")).toBe("quiet");
        expect(
            container.querySelector(
                ".text-meeting, .border-meeting, .bg-meeting",
            ),
        ).toBeNull();
        expect(
            screen.queryByRole("heading", { name: "1 · Task review" }),
        ).toBeNull();
        fireEvent.click(expand);
        const widget = screen
            .getByRole("heading", { name: "Agenda" })
            .closest("[data-workflow-widget]");
        if (!(widget instanceof HTMLElement))
            throw new Error("Missing agenda widget");
        expect(widget.querySelectorAll("[data-workflow-widget]")).toHaveLength(
            0,
        );
        expect(widget.querySelectorAll("footer")).toHaveLength(1);
        expect(
            widget.querySelectorAll(
                "[data-agenda-variant] > .flex > div > section",
            ),
        ).toHaveLength(2);
        for (const name of ["1 · Task review", "2 · Discussion points"]) {
            const section = within(widget)
                .getByRole("heading", { name })
                .closest("section");
            expect(section?.querySelector("footer")).toBeNull();
            expect(
                section?.querySelector(
                    'button[aria-label="Collapse task review"], button[aria-label="Collapse discussion points"]',
                ),
            ).toBeNull();
        }
        expect(widget.querySelector("footer")?.textContent).toContain(
            "Acme plan·1 of 2 discussed·2 tasks",
        );
        expect(
            await screen.findByText(
                /The recording is not shared with them yet/,
            ),
        ).toBeTruthy();
        expect(
            screen.queryByRole("button", { name: "Manage agenda sharing" }),
        ).toBeNull();
        expect(screen.queryByText("Agenda attached")).toBeNull();
    });
    it("remembers collapse per agenda", async () => {
        const view = mount();
        fireEvent.click(
            await screen.findByRole("button", { name: "Expand agenda" }),
        );
        view.unmount();
        mount();
        expect(
            await screen.findByRole("button", { name: "Collapse agenda" }),
        ).toBeTruthy();
        expect(
            window.localStorage.getItem("agenda:agenda:collapsed:recording"),
        ).toBe("false");
    });
    it.each([
        { isOwn: false },
        { view: "received" },
        { view: "org" },
    ])("hides detach for viewers %j", async (overrides) => {
        mount(overrides);
        await screen.findByRole("button", { name: "Expand agenda" });
        expect(
            screen.queryByRole("button", { name: "Detach agenda" }),
        ).toBeNull();
    });
    it("requires confirmation before detach and performs the existing request", async () => {
        const { changed } = mount();
        const detach = await screen.findByRole("button", {
            name: "Detach agenda",
        });
        expect(detach.textContent).toBe("");
        expect(detach.querySelector("svg")).toBeTruthy();
        fireEvent.click(detach);
        const dialog = within(screen.getByRole("alertdialog"));
        expect(
            dialog.getByText(
                "Detaching restores the standalone agenda. Existing summaries and actual task changes remain.",
            ),
        ).toBeTruthy();
        expect(
            request.mock.calls.some(([, init]) => init?.method === "POST"),
        ).toBe(false);
        fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("alertdialog")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Detach agenda" }));
        await act(async () =>
            fireEvent.click(screen.getByRole("button", { name: "Detach" })),
        );
        expect(request).toHaveBeenCalledWith(
            "/api/recordings/recording/agenda/detach",
            expect.objectContaining({ method: "POST" }),
        );
        expect(changed).toHaveBeenCalledOnce();
        expect(screen.queryByRole("heading", { name: "Agenda" })).toBeNull();
    });
    it("clears the previous recording's agenda without remounting the player slot", async () => {
        const renderRecording = (id: string, hasAgenda: boolean) =>
            frame(
                <RecordingAgenda
                    recording={{ ...recording, id, hasAgenda }}
                    folders={[]}
                    onChanged={vi.fn()}
                >
                    {({ agenda, nextMeeting }) => (
                        <>
                            {agenda}
                            <button type="button" data-testid="player-slot">
                                Play
                            </button>
                            {nextMeeting}
                        </>
                    )}
                </RecordingAgenda>,
            );
        const view = render(renderRecording("recording", true));
        await screen.findByRole("button", { name: "Expand agenda" });
        const player = screen.getByTestId("player-slot");
        view.rerender(renderRecording("other", false));
        expect(screen.getByTestId("player-slot")).toBe(player);
        expect(screen.queryByRole("heading", { name: "Agenda" })).toBeNull();
        await act(async () => {});
        expect(screen.queryByRole("heading", { name: "Agenda" })).toBeNull();
    });
    it("rolls back a failed detach", async () => {
        const { changed } = mount();
        fireEvent.click(
            await screen.findByRole("button", { name: "Detach agenda" }),
        );
        request.mockResolvedValueOnce(
            Response.json({ error: "Failed" }, { status: 500 }),
        );
        await act(async () =>
            fireEvent.click(screen.getByRole("button", { name: "Detach" })),
        );
        expect(changed).not.toHaveBeenCalled();
        expect(
            await screen.findByRole("button", { name: "Detach agenda" }),
        ).toBeTruthy();
        expect(toast.error).toHaveBeenCalledWith("Could not detach the agenda");
    });
});
describe.each([
    "meeting",
    "live",
    "recording",
] as const)("handled appearance in %s agendas", (variant) => {
    it.each([
        true,
        false,
    ])("uses native boxes where applicable and muted struck text (changeable=%s)", (changeable) => {
        const initial = {
            ...attached,
            tasks: attached.tasks.map((task) => ({
                ...task,
                canClose: changeable,
                canEdit: changeable,
            })),
            recordingItemId: variant === "recording" ? "recording" : null,
            permissions: { view: true, edit: changeable, manage: changeable },
        };
        render(
            frame(
                <AgendaBody
                    id="agenda"
                    initial={initial}
                    variant={variant}
                    userId="owner"
                />,
                false,
            ),
        );
        const disabled = !changeable || variant === "recording";
        const pointBox = screen.queryByRole("checkbox", {
            name: "Discussed: Handled point",
        });
        const taskBox = screen.getAllByRole("checkbox", { name: "Done" })[0];
        if (variant === "meeting") {
            expect(pointBox).toBeNull();
            expect(
                screen.queryByRole("checkbox", {
                    name: "Discussed: Open point",
                }),
            ).toBeNull();
        } else {
            expect(pointBox).toBeTruthy();
            expect(
                screen.getByRole("checkbox", { name: "Discussed: Open point" }),
            ).toHaveProperty("checked", false);
        }
        for (const box of [taskBox, ...(pointBox ? [pointBox] : [])]) {
            expect(box).toHaveProperty("checked", true);
            expect(box).toHaveProperty("disabled", disabled);
            expect(box.className).toContain("size-4");
            expect(box.className).toContain("mt-1");
            expect(box.className).toContain("accent-primary");
        }
        const pointText =
            screen.queryByDisplayValue("Handled point") ??
            screen.getByText("Handled point");
        expect(pointText.className).toContain("line-through");
        expect(pointText.className).toContain("text-muted-foreground");
        const taskText = screen.getByText("Handled task");
        expect(taskText.closest(".line-through")).toBeTruthy();
        expect(taskText.closest(".text-muted-foreground")).toBeTruthy();
        expect(
            screen
                .getByRole("group", { name: "Handled point" })
                .querySelector("time"),
        ).toBeTruthy();
    });
});
it("keeps status marks outside agendas and for dropped agenda tasks", () => {
    const { rerender } = render(
        frame(
            <TaskRow
                task={task("Done task", null, { status: "done" })}
                readOnly
                organizationOnly={false}
                onChange={vi.fn()}
            />,
        ),
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("img", { name: "Done" })).toBeTruthy();
    rerender(
        frame(
            <TaskRow
                task={task("Dropped task", null, { status: "dropped" })}
                readOnly
                readOnlyCheckbox
                organizationOnly={false}
                onChange={vi.fn()}
            />,
        ),
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("img", { name: "Dropped" })).toBeTruthy();
});
