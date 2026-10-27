// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import type { TranslationValues } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachRecordingDialog } from "@/components/meetings/attach-recording-dialog";
import { CreateMeetingDialog } from "@/components/meetings/create-meeting-dialog";
import { RecordingAgenda } from "@/components/meetings/recording-agenda";
import type {
    CalendarChoices,
    MeetingDetail,
} from "@/components/meetings/types";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";
import { at, detail } from "./ui-fixtures";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next-intl", () => ({
    useExtracted: () => (text: string, values?: TranslationValues) =>
        translatedSourceMessage("en", text, values),
    useLocale: () => "en",
    useFormatter: () => ({
        dateTime: (value: Date) => value.toISOString().slice(0, 16),
    }),
}));
vi.mock("@/components/meetings/agenda-body", () => ({
    AgendaBody: ({ initial }: { initial: MeetingDetail }) => (
        <div data-testid="readonly-agenda">{initial.title}</div>
    ),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const folder: RecordingFolder = {
    id: "folder",
    parentId: null,
    name: "Acme",
    kind: "custom",
    sortOrder: 0,
    scope: "personal",
    version: 0,
};
const recording: Recording = {
    id: "recording",
    filename: "Acme recording",
    duration: 3600000,
    filesize: 1,
    startTime: at,
    deviceSn: "test",
    isOwn: true,
};
const fetchMock = vi.fn();
let choices: CalendarChoices;
beforeEach(() => {
    choices = { reason: "not_configured", recurring: [], other: [] };
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => Response.json(choices));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});
describe("create dialog", () => {
    it.each([
        "hosted",
        "not_configured",
        "not_connected",
        "no_calendar_scope",
    ] as const)("keeps manual creation usable with Calendar reason %s", async (reason) => {
        choices = { reason, recurring: [], other: [] };
        const created = vi.fn();
        fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
            init.method === "POST"
                ? Response.json({ id: "agenda", meeting: detail() })
                : Response.json(choices),
        );
        render(
            <CreateMeetingDialog
                folders={[folder]}
                open
                onOpenChange={vi.fn()}
                onCreated={created}
            />,
        );
        const title = await screen.findByRole("textbox", { name: "Title" });
        const hint = screen.queryByRole("link", {
            name: /Connect Google Calendar/,
        });
        expect(Boolean(hint)).toBe(
            reason === "not_connected" || reason === "no_calendar_scope",
        );
        fireEvent.change(title, { target: { value: "Manual agenda" } });
        await act(async () =>
            fireEvent.click(screen.getByRole("button", { name: "Prepare" })),
        );
        expect(created).toHaveBeenCalledWith(
            "agenda",
            expect.objectContaining({ id: "agenda" }),
        );
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/meetings",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({
                    folderId: "folder",
                    title: "Manual agenda",
                }),
            }),
        );
    });
    it("opens a visible existing agenda instead of posting another", async () => {
        choices = {
            reason: null,
            recurring: [
                {
                    id: "event",
                    title: "Existing meeting",
                    start: at,
                    end: "2026-11-03T11:00:00Z",
                    attendees: [],
                    visibleAgenda: {
                        id: "existing",
                        author: { id: "other", name: "Dana Nováková" },
                    },
                    recordingCount: 4,
                },
            ],
            other: [],
        };
        const created = vi.fn();
        render(
            <CreateMeetingDialog
                folders={[folder]}
                open
                onOpenChange={vi.fn()}
                onCreated={created}
            />,
        );
        fireEvent.click(await screen.findByRole("radio"));
        await act(async () =>
            fireEvent.click(
                screen.getByRole("button", { name: "Open agenda" }),
            ),
        );
        expect(created).toHaveBeenCalledWith("existing");
        expect(
            fetchMock.mock.calls.some((call) => call[1]?.method === "POST"),
        ).toBe(false);
    });
});
it("shows a widening-sharing audience, attaches explicitly and reads back the absorbed state", async () => {
    let attached = false;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
        if (url.endsWith("/attach")) {
            attached = true;
            return Response.json({ success: true });
        }
        if (url.includes("agenda-candidates"))
            return Response.json({
                candidates: attached
                    ? []
                    : [
                          {
                              id: "agenda",
                              title: "Prepared agenda",
                              start: at,
                              end: null,
                              folder: { id: "folder", name: "Acme" },
                              overlapMs: 1800000,
                              widensSharing: true,
                              audience: {
                                  organization: true,
                                  userIds: [],
                                  users: [],
                              },
                          },
                      ],
            });
        if (url.endsWith("/next-meeting"))
            return Response.json({ event: null });
        expect(init.method).toBe("GET");
        return attached
            ? Response.json({
                  agenda: detail({
                      recordingItemId: "recording",
                      title: "Prepared agenda",
                  }),
              })
            : Response.json({ agenda: null });
    });
    const changed = vi.fn();
    render(
        <RecordingAgenda
            recording={recording}
            folders={[folder]}
            onChanged={changed}
        />,
    );
    await screen.findByText("Attach an agenda?");
    expect(
        screen.getByText(/Shared-folder audience: Organization/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("radio"));
    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Attach agenda" })),
    );
    expect(changed).toHaveBeenCalled();
    expect(screen.getByText("Agenda attached")).toBeTruthy();
    expect(screen.getByTestId("readonly-agenda")).toBeTruthy();
    expect(screen.queryByText(/published|now visible/)).toBeNull();
});
it("keeps ordinary recordings free of agenda UI and uses the optional lookup", async () => {
    fetchMock.mockImplementation(async (url: string) =>
        Response.json(
            url.endsWith("/agenda")
                ? { agenda: null }
                : url.endsWith("/next-meeting")
                  ? { event: null }
                  : { candidates: [] },
        ),
    );
    const { container } = render(
        <RecordingAgenda
            recording={recording}
            folders={[folder]}
            onChanged={vi.fn()}
        />,
    );
    await act(async () => {});
    expect(container.textContent).toBe("");
    expect(fetchMock).toHaveBeenCalledWith(
        "/api/recordings/recording/agenda",
        expect.objectContaining({ method: "GET" }),
    );
    expect(
        fetchMock.mock.calls.some(([url]) => url.startsWith("/api/meetings/")),
    ).toBe(false);
});
it("offers prepare next only when the route returns an instance", async () => {
    fetchMock.mockImplementation(async (url: string) =>
        url.endsWith("/next-meeting")
            ? Response.json({
                  event: {
                      id: "next-event",
                      title: "Next",
                      start: at,
                      end: at,
                      attendees: [],
                      agendaId: "existing",
                  },
              })
            : url.includes("candidates")
              ? Response.json({ candidates: [] })
              : Response.json({
                    agenda: detail({ recordingItemId: "recording" }),
                }),
    );
    render(
        <RecordingAgenda
            recording={recording}
            folders={[folder]}
            onChanged={vi.fn()}
        />,
    );
    const prepare = await screen.findByRole("button", {
        name: "Prepare next meeting",
    });
    fireEvent.click(prepare);
    expect(push).toHaveBeenCalledWith("/dashboard?meeting=existing");
});
it("held attachment offers owned recordings, correct minutes and the upload hand-off", async () => {
    const upload = vi.fn();
    window.addEventListener("meeting-upload", upload);
    render(
        <AttachRecordingDialog
            detail={detail({ state: "held" })}
            recordings={[recording]}
            folders={[folder]}
            open
            onOpenChange={vi.fn()}
            onAttached={vi.fn()}
        />,
    );
    expect(screen.getByText(/60 min/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Upload a file…" }));
    expect(upload).toHaveBeenCalledWith(
        expect.objectContaining({
            detail: { agendaId: "agenda", folderId: "folder" },
        }),
    );
    window.removeEventListener("meeting-upload", upload);
});
