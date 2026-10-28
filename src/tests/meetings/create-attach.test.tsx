// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import { useContext, useEffect } from "react";
import type { TranslationValues } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachRecordingDialog } from "@/components/meetings/attach-recording-dialog";
import { CreateMeetingDialog } from "@/components/meetings/create-meeting-dialog";
import { RecordingAgenda } from "@/components/meetings/recording-agenda";
import { RecordingAgendaContext } from "@/components/meetings/recording-agenda-context";
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
        list: (values: string[]) => values.join(", "),
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
    Element.prototype.scrollIntoView = vi.fn();
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
                folderId="folder"
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
                folderId="folder"
                open
                onOpenChange={vi.fn()}
                onCreated={created}
            />,
        );
        fireEvent.click(
            await screen.findByRole("combobox", { name: "Calendar event" }),
        );
        fireEvent.click(
            screen.getByRole("option", { name: /Existing meeting/ }),
        );
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
it.each([
    true,
    false,
])("shows a widening-sharing audience (Organization=%s), attaches explicitly and reads back the absorbed state", async (organization) => {
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
                              folders: [
                                  { id: "folder", name: "Acme" },
                                  { id: "private", name: "Private planning" },
                              ],
                              overlapMs: 1800000,
                              widensSharing: true,
                              audience: {
                                  organization,
                                  userIds: organization
                                      ? []
                                      : ["other", "third"],
                                  users: organization
                                      ? []
                                      : [
                                            {
                                                id: "other",
                                                name: "Alex Example",
                                            },
                                            {
                                                id: "third",
                                                name: "Robin Example",
                                            },
                                        ],
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
            recording={{ ...recording, agendaCandidateCount: 1 }}
            folders={[folder]}
            onChanged={changed}
        />,
    );
    await screen.findByText("Attach an agenda?");
    expect(
        screen.getByText(
            organization
                ? /Shared-folder audience: Organization/
                : /Shared-folder audience: Alex Example, Robin Example/,
        ),
    ).toBeTruthy();
    expect(screen.getByText(/Acme, Private planning/)).toBeTruthy();
    expect(
        screen.getByText(/filed into all of the agenda’s folders/),
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
    expect(fetchMock).not.toHaveBeenCalled();
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
            recording={{ ...recording, hasAgenda: true }}
            folders={[folder]}
            onChanged={vi.fn()}
        />,
    );
    const prepare = await screen.findByRole("button", {
        name: "Prepare next agenda",
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

it.each([
    null,
    "folder",
    "organization",
    "organization-root",
])("preselects only invocation context %s, never another folder", async (folderId) => {
    const privateRoot: RecordingFolder = {
        ...folder,
        id: "private",
        name: "Private",
        kind: "private",
    };
    const organization: RecordingFolder = {
        ...folder,
        id: "organization",
        scope: "org",
    };
    const organizationRoot: RecordingFolder = {
        ...organization,
        id: "organization-root",
        kind: "public",
    };
    render(
        <CreateMeetingDialog
            folders={[organization, organizationRoot, privateRoot, folder]}
            folderId={folderId}
            open
            onOpenChange={vi.fn()}
            onCreated={vi.fn()}
        />,
    );
    await act(async () => {});
    const picker = screen.getByRole("combobox", { name: "Folder" });
    if (folderId === "folder" || folderId === "organization")
        expect(
            fetchMock.mock.calls.some(([url]) =>
                String(url).includes(`folderId=${folderId}`),
            ),
        ).toBe(true);
    else expect(picker.textContent).toContain("Choose a folder");
    if (!folderId || folderId === "organization-root") {
        expect(fetchMock).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Prepare" })).toHaveProperty(
            "disabled",
            true,
        );
    }
});
function SummaryReporter({
    hasAgenda,
    count = 0,
    run = () => {},
    working = false,
}: {
    hasAgenda: boolean;
    count?: number;
    run?: () => void;
    working?: boolean;
}) {
    const report = useContext(RecordingAgendaContext);
    useEffect(() => {
        report?.({
            itemId: "recording",
            presence: { hasAgenda, agendaCandidateCount: count },
            hasSummary: true,
            working,
            disabled: working,
            run,
        });
        return () => report?.(null);
    }, [report, hasAgenda, count, run, working]);
    return null;
}
it("uses summary presence for attached reads and offers manual re-summary only without an outcome", async () => {
    const run = vi.fn();
    fetchMock.mockImplementation(async (url: string) =>
        Response.json(
            url.endsWith("/agenda")
                ? { agenda: detail({ recordingItemId: "recording" }) }
                : { event: null },
        ),
    );
    render(
        <RecordingAgenda
            recording={recording}
            folders={[folder]}
            onChanged={vi.fn()}
        >
            {({ agenda }) => (
                <>
                    <SummaryReporter hasAgenda run={run} />
                    {agenda}
                </>
            )}
        </RecordingAgenda>,
    );
    const action = await screen.findByRole("button", { name: "Re-summarize" });
    expect(
        screen.getByText(
            "This summary was made before the agenda was attached.",
        ),
    ).toBeTruthy();
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(action);
    expect(run).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "/api/recordings/recording/agenda",
        "/api/recordings/recording/next-meeting",
    ]);
});
it.each([
    0, 2,
])("uses summary candidate count %s without loading next-meeting or agenda", async (count) => {
    fetchMock.mockResolvedValue(Response.json({ candidates: [] }));
    const run = vi.fn();
    render(
        <RecordingAgenda
            recording={recording}
            folders={[folder]}
            onChanged={vi.fn()}
        >
            {() => (
                <SummaryReporter hasAgenda={false} count={count} run={run} />
            )}
        </RecordingAgenda>,
    );
    await act(async () => {});
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(
        count > 0 ? ["/api/recordings/recording/agenda-candidates"] : [],
    );
});
it("keeps the late-attach hint out when an outcome already exists", async () => {
    fetchMock.mockImplementation(async (url: string) =>
        Response.json(
            url.endsWith("/agenda")
                ? {
                      agenda: detail({
                          recordingItemId: "recording",
                          outcomeSummaryId: "summary",
                      }),
                  }
                : { event: null },
        ),
    );
    const run = vi.fn();
    render(
        <RecordingAgenda
            recording={{ ...recording, hasAgenda: true }}
            folders={[folder]}
            onChanged={vi.fn()}
        >
            {({ agenda }) => (
                <>
                    <SummaryReporter hasAgenda run={run} />
                    {agenda}
                </>
            )}
        </RecordingAgenda>,
    );
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Re-summarize" })).toBeNull();
});

it("refreshes agenda outcomes once a manual summary settles, without polling", async () => {
    let outcomeSummaryId: string | null = null;
    fetchMock.mockImplementation(async (url: string) =>
        Response.json(
            url.endsWith("/agenda")
                ? {
                      agenda: detail({
                          recordingItemId: "recording",
                          outcomeSummaryId,
                      }),
                  }
                : { event: null },
        ),
    );
    const run = vi.fn();
    function frame(working: boolean) {
        return (
            <RecordingAgenda
                recording={{ ...recording, hasAgenda: true }}
                folders={[folder]}
                onChanged={vi.fn()}
            >
                {({ agenda }) => (
                    <>
                        <SummaryReporter
                            hasAgenda
                            run={run}
                            working={working}
                        />
                        {agenda}
                    </>
                )}
            </RecordingAgenda>
        );
    }
    const { rerender } = render(frame(false));
    await screen.findByRole("button", { name: "Re-summarize" });
    fetchMock.mockClear();
    rerender(frame(true));
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    outcomeSummaryId = "new-summary";
    rerender(frame(false));
    await act(async () => {});
    expect(
        screen.queryByText(
            "This summary was made before the agenda was attached.",
        ),
    ).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "/api/recordings/recording/agenda",
        "/api/recordings/recording/next-meeting",
    ]);
    expect(run).not.toHaveBeenCalled();
});

it("retains meeting presence while the summary widget refreshes or is hidden", async () => {
    fetchMock.mockResolvedValue(
        Response.json({
            candidates: [
                {
                    id: "agenda",
                    title: "Prepared agenda",
                    start: at,
                    end: null,
                    folders: [{ id: "folder", name: "Acme" }],
                    overlapMs: 60000,
                    widensSharing: false,
                },
            ],
        }),
    );
    const run = vi.fn();
    function frame(show: boolean) {
        return (
            <RecordingAgenda
                recording={recording}
                folders={[folder]}
                onChanged={vi.fn()}
            >
                {({ notice }) => (
                    <>
                        {show && (
                            <SummaryReporter
                                hasAgenda={false}
                                count={1}
                                run={run}
                            />
                        )}
                        {notice}
                    </>
                )}
            </RecordingAgenda>
        );
    }
    const { rerender } = render(frame(true));
    await screen.findByText("Attach an agenda?");
    expect(fetchMock).toHaveBeenCalledOnce();
    rerender(frame(false));
    await act(async () => {});
    expect(screen.getByText("Attach an agenda?")).toBeTruthy();
    rerender(frame(true));
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledOnce();
});
