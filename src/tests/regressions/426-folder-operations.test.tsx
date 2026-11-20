// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { Workstation } from "@/components/dashboard/workstation";
import {
    RECORDING_DRAG_TYPE,
    RECORDING_SOURCE_FOLDER_DRAG_TYPE,
    RECORDING_SOURCE_SCOPE_DRAG_TYPES,
} from "@/lib/folders/drag";
import type { CategorizationPanelPresentation } from "@/lib/pipeline/categorization-presentation";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";
import { processingFixture } from "@/tests/pipeline/processing-fixture";
import type { FolderOrganization, RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

const mocks = vi.hoisted(() => ({
    error: vi.fn(),
    router: { refresh: vi.fn(), push: vi.fn(), replace: vi.fn() },
}));
vi.mock("sonner", () => ({
    toast: {
        error: mocks.error,
        success: vi.fn(),
        dismiss: vi.fn(),
        custom: vi.fn(),
    },
}));
vi.mock("next/navigation", () => ({
    useRouter: () => mocks.router,
    useSearchParams: () => new URLSearchParams(window.location.search),
    usePathname: () => "/dashboard",
}));
vi.mock("@/components/app-chrome-provider", () => ({
    useAppChrome: () => ({}),
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("@/hooks/use-transcribe-queue", () => ({
    useTranscribeQueue: () => ({
        inFlightActions: new Map(),
        observeTranscriptionById: vi.fn(),
    }),
}));
vi.mock("@/components/recordings/ai-cost-summary", () => ({
    AiCostSummary: () => null,
}));
vi.mock("@/components/dashboard/recording-player", () => ({
    RecordingPlayer: () => <div data-testid="player" />,
    transcriptPlayback: () => null,
}));

const root: RecordingFolder = {
    id: "org-root",
    name: "Organization",
    parentId: null,
    scope: "org",
    kind: "public",
    version: 1,
    sortOrder: 0,
};
const orgFolder = {
    ...root,
    id: "org-design",
    name: "Design",
    parentId: root.id,
    kind: "custom" as const,
};
const privateRoot: RecordingFolder = {
    ...root,
    id: "private-root",
    name: "Private",
    scope: "personal",
    kind: "private",
};
const privateFolder: RecordingFolder = {
    ...privateRoot,
    id: "private-notes",
    name: "Notes",
    parentId: privateRoot.id,
    kind: "custom",
};
const child = {
    ...privateFolder,
    id: "private-child",
    name: "Minutes",
    parentId: privateFolder.id,
};
const restricted = {
    ...orgFolder,
    id: "org-restricted",
    name: "Restricted",
    restricted: true as const,
    access: true,
};
const item: Recording = {
    id: "folder-operations",
    filename: "Planning session",
    view: "private",
    isOwn: true,
    duration: 1000,
    startTime: new Date(0).toISOString(),
    filesize: 10,
    deviceSn: "local",
};
const other = { ...item, id: "other-recording", filename: "Other recording" };
const orgRow = { ...item, view: "org" as const };
const intent = {
    folderId: orgFolder.id,
    name: "Design",
    path: "Organization / Design",
    confirmationRequired: false,
    confirmed: false,
};
const callsProfile = {
    id: "profile-2",
    name: "Calls",
    scope: "personal",
} as const;

function projection({
    waitingForCategorize,
    shared = false,
    intentVisible = false,
    filed = [] as RecordingFolder[],
    again = false,
}: {
    waitingForCategorize?: "needs_folder" | "needs_profile";
    shared?: boolean;
    intentVisible?: boolean;
    filed?: RecordingFolder[];
    again?: boolean;
} = {}) {
    return {
        ...processingFixture({
            itemId: item.id,
            kind: "audio",
            legacy: !waitingForCategorize,
            manualOnly: false,
            phases: {
                categorize: {
                    state: waitingForCategorize ? "waiting" : "done",
                    reason: waitingForCategorize ?? "legacy",
                    generation: 1,
                    at: item.startTime,
                },
            },
            profile: null,
            placements: filed.map((folder) => ({
                ...folder,
                path: folder.name,
            })),
            intents: intentVisible ? [intent] : [],
            outputs: { transcript: true, summary: true, learn: false },
            processAgain: again,
            processAgainReason: null,
            learnFindingsWaiting: 0,
            taskReviewWaiting: 0,
            jobs: { transcription: null, summary: null },
            failures: [],
        }),
        access: {
            shared,
            role: "owner" as const,
            contentView: shared ? ("org" as const) : ("private" as const),
        },
    };
}

function deferredResponse() {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const dashboardFolders = [
    root,
    orgFolder,
    restricted,
    privateRoot,
    privateFolder,
    child,
];

function folderSnapshot(filed: RecordingFolder[]): FolderOrganization {
    return {
        folders: dashboardFolders,
        assignments: filed.map((folder) => ({
            recordingId: item.id,
            folderId: folder.id,
        })),
    };
}

function open(
    initial = projection(),
    view: "private" | "org" | "received" = "private",
    panel: Partial<CategorizationPanelPresentation> = {},
) {
    const folder =
        view === "org"
            ? "&folder=org-design&view=org"
            : view === "received"
              ? "&folder=private-root&view=received"
              : "&folder=private-root";
    window.history.replaceState(
        { mobileView: "detail" },
        "",
        `/dashboard?recording=${item.id}${folder}`,
    );
    let processing = initial;
    const dashboardReads: ReturnType<typeof deferredResponse>[] = [];
    let deferDashboard = false;
    const writes: {
        method: string;
        body?: string;
        reply: ReturnType<typeof deferredResponse>;
    }[] = [];
    const reads: ReturnType<typeof deferredResponse>[] = [];
    let deferReads = false;
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
        if (url === "/api/folders?dashboard=1") {
            if (!deferDashboard)
                return Response.json(
                    folderSnapshot(
                        processing.placements.map(
                            (placement) =>
                                dashboardFolders.find(
                                    ({ id }) => id === placement.id,
                                ) ?? privateFolder,
                        ),
                    ),
                );
            const reply = deferredResponse();
            dashboardReads.push(reply);
            return reply.promise;
        }
        if (url.includes("processing=1")) {
            if (url.includes(other.id))
                return Response.json({
                    processing: { ...projection(), itemId: other.id },
                });
            if (!deferReads) return Response.json({ processing });
            const reply = deferredResponse();
            reads.push(reply);
            return reply.promise;
        }
        if (
            url.split("?")[0].endsWith("/folders") ||
            url.includes("/intended-placements/") ||
            (url.endsWith("/categorize") && options?.method === "POST")
        ) {
            const reply = deferredResponse();
            writes.push({
                method: options?.method ?? "GET",
                body:
                    typeof options?.body === "string"
                        ? options.body
                        : undefined,
                reply,
            });
            const response = await reply.promise;
            if (response.ok) {
                const result: { processing?: typeof processing | null } =
                    await response.clone().json();
                if (result.processing) processing = result.processing;
                else if (
                    result.processing === null &&
                    options?.method === "DELETE"
                )
                    processing = projection();
            }
            return response;
        }
        if (url.endsWith("/categorize/preview"))
            return Response.json({
                resolution: {
                    status: "resolved",
                    profile: callsProfile,
                    manualOnly: false,
                    source: "folder",
                },
            });
        if (url.endsWith("/categorize")) {
            const data: CategorizationPanelPresentation = {
                itemId: item.id,
                folders: dashboardFolders.map((folder) => ({
                    ...folder,
                    path: folder.name,
                })),
                selectedFolderIds: [],
                profiles: [callsProfile],
                currentProfile: null,
                currentManualOnly: false,
                canCreateOrganizationFolders: false,
                resolution: { status: "choose", candidates: [] },
                ...panel,
            };
            return Response.json(data);
        }
        if (url.includes("/withdraw-preview"))
            return Response.json({ retentionSeconds: null, deletionAt: null });
        return Response.json({});
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal(
        "IntersectionObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    const props = {
        recordings: [
            view === "received" ? { ...item, view, isOwn: false } : item,
            other,
        ],
        transcriptions: new Map(),
        transcriptVariants: new Map(),
        initialSettings: {
            dateTimeFormat: "relative",
            recordingListSortOrder: "oldest",
            chatterKindFilter: "all",
            itemsPerPage: 50,
            listDensity: "comfortable",
            theme: "light",
            defaultPlaybackSpeed: 1,
            defaultVolume: 75,
            autoPlayNext: false,
            playerScrubber: "waveform",
            syncInterval: 300_000,
            autoSyncEnabled: false,
            syncOnMount: false,
            syncOnVisibilityChange: false,
            syncNotifications: false,
            browserNotifications: false,
            onboardingCompleted: true,
        },
        plaudNeedsReconnect: false,
        isHosted: false,
        exportProviders: { filesystem: false, googleDrive: false, mail: false },
        initialFolderOrganization: {
            folders: dashboardFolders,
            assignments: initial.placements.map(({ id: folderId }) => ({
                recordingId: item.id,
                folderId,
            })),
        },
        organizationLibrary: {
            recordings: view === "org" ? [orgRow] : [],
            transcriptions: new Map(),
            transcriptVariants: new Map(),
        },
    } satisfies ComponentProps<typeof Workstation>;
    const tree = render(
        <ConfirmDialogProvider>
            <Workstation {...props} />
        </ConfirmDialogProvider>,
    );
    return {
        writes,
        reads,
        dashboardReads,
        deferDashboard: () => {
            deferDashboard = true;
        },
        receiveRouterSnapshot: (
            initialFolderOrganization: FolderOrganization,
        ) =>
            tree.rerender(
                <ConfirmDialogProvider>
                    <Workstation
                        {...props}
                        initialFolderOrganization={initialFolderOrganization}
                    />
                </ConfirmDialogProvider>,
            ),
        setProcessing: (next: typeof processing) => {
            processing = next;
        },
        deferReads: () => {
            deferReads = true;
        },
        switchItem: () => fireEvent.click(listRow("Other recording")),
        reopen: () => fireEvent.click(listRow("Planning session")),
        dropOrgRow: () =>
            tree.rerender(
                <ConfirmDialogProvider>
                    <Workstation
                        {...props}
                        organizationLibrary={{
                            ...props.organizationLibrary,
                            recordings: [],
                        }}
                    />
                </ConfirmDialogProvider>,
            ),
    };
}

function listRow(name: string) {
    const row = screen
        .getAllByRole<HTMLButtonElement>("button", { name: new RegExp(name) })
        .find((button) => button.draggable);
    if (!row) throw new Error(`Missing list row for ${name}`);
    return row;
}

function chipContent(button: HTMLElement | null) {
    if (!button?.parentElement) throw new Error("Missing folder chip");
    return within(button.parentElement);
}

async function file(name: string) {
    fireEvent.click(
        await screen.findByRole("combobox", { name: "Add to folder" }),
    );
    fireEvent.click(
        (await screen.findAllByRole("option", { name: new RegExp(name) }))[0],
    );
}

async function chooseFilingFolder(form: HTMLElement, folder: RecordingFolder) {
    fireEvent.click(within(form).getByRole("combobox", { name: "Folder" }));
    fireEvent.click(
        screen.getByRole("option", {
            name: new RegExp(`^${folder.name}( |$)`),
        }),
    );
    await waitFor(() =>
        expect(
            within(form).getByRole("combobox", { name: "Profile" }).textContent,
        ).toBe(callsProfile.name),
    );
}

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

it.each([
    { outcome: "refused", success: false },
    { outcome: "saved", success: true },
])("shows only the saving folder row until the filing is $outcome", async ({
    success,
}) => {
    const app = open(projection({ waitingForCategorize: "needs_folder" }));
    const form = await screen.findByRole("region", {
        name: "Categorize recording",
    });
    await chooseFilingFolder(form, privateFolder);
    fireEvent.click(within(form).getByRole("combobox", { name: "Profile" }));
    fireEvent.click(screen.getByRole("option", { name: "Nothing automatic" }));
    const submit = within(form).getByRole("button", {
        name: "Categorize recording",
    });
    fireEvent.click(submit);
    await waitFor(() => expect(app.writes).toHaveLength(1));

    const row = screen.getByTestId("processing-folder-row");
    const chip = within(row).getByRole("button", { name: "Remove from Notes" });
    expect(chip.parentElement?.classList.contains("opacity-60")).toBe(true);
    expect(chipContent(chip).getByRole("status").textContent).toBe("Saving…");
    expect(
        screen.queryByRole("region", { name: "Categorize recording" }),
    ).toBeNull();
    expect(form.isConnected).toBe(true);
    expect(JSON.parse(app.writes[0].body ?? "")).toEqual({
        folderIds: [privateFolder.id],
        manualOnly: true,
    });

    await act(async () =>
        app.writes[0].reply.resolve(
            success
                ? Response.json({
                      placement: "categorized",
                      processing: projection({ filed: [privateFolder] }),
                  })
                : new Response(null, { status: 500 }),
        ),
    );
    if (success) {
        expect(form.isConnected).toBe(false);
        const saved = within(screen.getByTestId("processing-folder-row"));
        expect(
            saved.getByRole("button", { name: "Remove from Notes" }),
        ).toBeTruthy();
        expect(saved.queryByText("Saving…")).toBeNull();
    } else {
        expect(
            screen.getByRole("region", { name: "Categorize recording" }),
        ).toBe(form);
        expect(
            within(form).getByRole("combobox", { name: "Folder" }).textContent,
        ).toContain(privateFolder.name);
        expect(
            within(form).getByRole("combobox", { name: "Profile" }).textContent,
        ).toBe("Nothing automatic");
        expect(submit).toHaveProperty("disabled", false);
        expect(mocks.error).toHaveBeenCalledWith(
            "The item could not be filed.",
            expect.anything(),
        );
        expect(screen.queryByTestId("processing-folder-row")).toBeNull();
        expect(
            within(listRow("Planning session")).queryByText(privateFolder.name),
        ).toBeNull();
    }
});

it("keeps only the busy profile form visible and posts the current placements and intents", async () => {
    const placement = {
        filed: [privateRoot, privateFolder],
        intentVisible: true,
    };
    const app = open(
        projection({ ...placement, waitingForCategorize: "needs_profile" }),
        "private",
        { selectedFolderIds: [privateFolder.id] },
    );
    const form = await screen.findByRole("region", {
        name: "Categorize recording",
    });
    fireEvent.click(within(form).getByRole("combobox", { name: "Profile" }));
    fireEvent.click(screen.getByRole("option", { name: callsProfile.name }));
    const submit = within(form).getByRole("button", {
        name: "Categorize recording",
    });
    expect(submit).toHaveProperty("disabled", false);
    fireEvent.click(submit);
    await waitFor(() => expect(app.writes).toHaveLength(1));

    expect(screen.getByRole("region", { name: "Categorize recording" })).toBe(
        form,
    );
    expect(submit).toHaveProperty("disabled", true);
    expect(screen.queryByTestId("processing-folder-row")).toBeNull();
    expect(screen.queryByText("Saving…")).toBeNull();
    expect(JSON.parse(app.writes[0].body ?? "")).toEqual({
        folderIds: [privateFolder.id, intent.folderId],
        profileId: callsProfile.id,
    });
    await act(async () =>
        app.writes[0].reply.resolve(
            Response.json({
                placement: "categorized",
                processing: projection(placement),
            }),
        ),
    );
});

it("retains a restricted Organization placement absent from the filing choices", async () => {
    const app = open(
        projection({
            filed: [restricted],
            waitingForCategorize: "needs_folder",
        }),
        "private",
        { folders: [{ ...orgFolder, path: orgFolder.name }] },
    );
    const form = await screen.findByRole("region", {
        name: "Categorize recording",
    });
    await chooseFilingFolder(form, orgFolder);
    fireEvent.click(
        within(form).getByRole("button", { name: "Categorize recording" }),
    );
    await waitFor(() => expect(app.writes).toHaveLength(1));

    expect(JSON.parse(app.writes[0].body ?? "")).toEqual({
        folderIds: [orgFolder.id, restricted.id],
        profileId: callsProfile.id,
    });
    await act(async () =>
        app.writes[0].reply.resolve(
            Response.json({
                placement: "categorized",
                processing: projection({
                    filed: [restricted],
                    intentVisible: true,
                }),
            }),
        ),
    );
});

it("removes only the refused share chip while a second filing waits", async () => {
    const app = open();
    await file("Design");
    await waitFor(() => expect(app.writes).toHaveLength(1));
    const pending = await screen.findByRole("button", {
        name: "Remove from Design",
    });
    expect(pending.parentElement?.textContent).toContain("Saving…");
    await file("Notes");
    expect(
        await screen.findByRole("button", { name: "Remove from Notes" }),
    ).toBeTruthy();
    expect(app.writes).toHaveLength(1);
    await act(async () =>
        app.writes[0].reply.resolve(
            Response.json(
                {
                    code: "SHARE_REQUIREMENTS_UNMET",
                    error: "Share blocked",
                    details: {
                        problems: [
                            { kind: "learn_unfinished", waiting: "learn" },
                        ],
                    },
                },
                { status: 409 },
            ),
        ),
    );
    expect(
        screen.queryByRole("button", { name: "Remove from Design" }),
    ).toBeNull();
    expect(
        screen.getByRole("button", { name: "Remove from Notes" }),
    ).toBeTruthy();
    const row = within(listRow("Planning session"));
    expect(row.getByText("Notes")).toBeTruthy();
    expect(row.queryByText("Design")).toBeNull();
    expect(
        screen.getByRole("button", { name: "Notes, 1 recording" }),
    ).toBeTruthy();
    expect(
        screen.getByRole("button", { name: "Design, 0 recordings" }),
    ).toBeTruthy();
    expect(app.writes).toHaveLength(2);
    expect(mocks.error).toHaveBeenCalledWith(
        "Not shared. Finish Learn before sharing this recording.",
        {
            action: {
                label: "Open recording to review",
                onClick: expect.any(Function),
            },
        },
    );
    const saved = projection({ filed: [privateFolder] });
    app.setProcessing(saved);
    await act(async () =>
        app.writes[1].reply.resolve(
            Response.json({ placement: "filed", processing: saved }),
        ),
    );
    expect(
        screen.getByRole("button", { name: "Remove from Notes" }),
    ).toBeTruthy();
});

it("renders a deferred share as a dashed intent", async () => {
    const app = open();
    await file("Design");
    await waitFor(() => expect(app.writes).toHaveLength(1));
    const saved = projection({ intentVisible: true });
    app.setProcessing(saved);
    await act(async () =>
        app.writes[0].reply.resolve(
            Response.json({ placement: "intended", processing: saved }),
        ),
    );
    const cancel = await screen.findByRole("button", {
        name: "Cancel Organization / Design",
    });
    expect(cancel.parentElement?.className).toContain("border-dashed");
    expect(
        screen.queryByRole("button", { name: "Remove from Design" }),
    ).toBeNull();
});

it("keeps the owner's item selected when its Organization row is withdrawn", async () => {
    const app = open(projection({ shared: true, filed: [orgFolder] }), "org");
    fireEvent.click(
        await screen.findByRole("button", { name: "Remove from Design" }),
    );
    const withdraw = await screen.findByRole<HTMLButtonElement>("button", {
        name: "Take out of the Organization",
    });
    await waitFor(() => expect(withdraw.disabled).toBe(false));
    fireEvent.click(withdraw);
    await waitFor(() => expect(app.writes).toHaveLength(1));
    app.dropOrgRow();
    expect(screen.getByTestId("player")).toBeTruthy();
    app.setProcessing(projection());
    await act(async () =>
        app.writes[0].reply.resolve(
            Response.json({ placement: "unshared", processing: projection() }),
        ),
    );
    expect(window.location.search).toBe(`?recording=${item.id}`);
    expect(screen.getByTestId("player")).toBeTruthy();
});

it("keeps a pending filing over a refetched projection", async () => {
    const app = open();
    await file("Notes");
    await waitFor(() => expect(app.writes).toHaveLength(1));
    await act(async () => invalidateItemProcessing(item.id));
    const pending = screen.getByRole("button", { name: "Remove from Notes" });
    expect(pending.parentElement?.textContent).toContain("Saving…");
    await act(async () =>
        app.writes[0].reply.resolve(
            Response.json({
                placement: "filed",
                processing: projection({ filed: [privateFolder] }),
            }),
        ),
    );
});

it.each([
    true,
    false,
])("keeps a cancelled intent hidden during a poll and uses the fresh base after settlement (success %s)", async (success) => {
    const app = open(projection({ intentVisible: true }));
    const cancel = await screen.findByRole("button", {
        name: "Cancel Organization / Design",
    });
    app.deferReads();
    act(() => invalidateItemProcessing(item.id));
    fireEvent.click(cancel);
    expect(
        screen.queryByRole("button", {
            name: cancel.getAttribute("aria-label") ?? "",
        }),
    ).toBeNull();
    const fresh = projection({
        intentVisible: success,
        filed: [privateFolder],
    });
    await act(async () =>
        app.reads[0].resolve(Response.json({ processing: fresh })),
    );
    expect(
        screen.queryByRole("button", { name: /Cancel Organization/ }),
    ).toBeNull();
    expect(
        screen.getByRole("button", { name: "Remove from Notes" }),
    ).toBeTruthy();
    await act(async () =>
        app.writes[0].reply.resolve(
            success
                ? Response.json({
                      placement: "removed",
                      processing: projection({ filed: [privateFolder] }),
                  })
                : new Response(null, { status: 500 }),
        ),
    );
    expect(
        screen.queryByRole("button", { name: /Cancel Organization/ }),
    ).toBeNull();
    expect(
        screen.getByRole("button", { name: "Remove from Notes" }),
    ).toBeTruthy();
});

it("warns before open publication while a restricted filing is queued", async () => {
    const app = open();
    await file("Restricted");
    await waitFor(() => expect(app.writes).toHaveLength(1));
    await file("Design");
    expect(
        await screen.findByRole("alertdialog", {
            name: "Share with the whole Organization?",
        }),
    ).toBeTruthy();
    expect(app.writes).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const saved = projection({ filed: [restricted] });
    await act(async () =>
        app.writes[0].reply.resolve(
            Response.json({ placement: "withheld", processing: saved }),
        ),
    );
    expect(app.writes).toHaveLength(1);
});

it("settles a stale filing before building a queued profile request after switching items", async () => {
    const app = open();
    await screen.findByTestId("profile-chip");
    await file("Notes");
    await waitFor(() => expect(app.writes).toHaveLength(1));
    const profile = screen.getByTestId("profile-chip");
    fireEvent.mouseEnter(profile);
    fireEvent.pointerDown(profile, { button: 0, ctrlKey: false });
    fireEvent.click(
        await screen.findByRole("menuitemradio", { name: "Calls" }),
    );
    app.switchItem();
    app.deferReads();
    await act(async () =>
        app.writes[0].reply.resolve(
            Response.json({ placement: "filed", processingStale: true }),
        ),
    );
    expect(app.writes).toHaveLength(1);
    await waitFor(() => expect(app.reads).toHaveLength(1));
    app.reopen();
    const pending = await screen.findByRole("button", {
        name: "Remove from Notes",
    });
    expect(pending.parentElement?.textContent).toContain("Saving…");
    const saved = projection({ filed: [privateFolder] });
    app.setProcessing(saved);
    await act(async () =>
        app.reads[0].resolve(Response.json({ processing: saved })),
    );
    await waitFor(() => expect(app.writes).toHaveLength(2));
    expect(JSON.parse(app.writes[1].body ?? "")).toEqual({
        folderIds: [privateFolder.id],
        profileId: "profile-2",
    });
    await act(async () =>
        app.writes[1].reply.resolve(
            Response.json({ placement: "categorized", processing: saved }),
        ),
    );
    expect(
        screen.getByRole("button", { name: "Remove from Notes" }),
    ).toBeTruthy();
});

it("reconciles a pruned parent when its stale filing settles after switching items", async () => {
    const app = open(projection({ filed: [privateFolder] }));
    await file("Minutes");
    await waitFor(() => expect(app.writes).toHaveLength(1));
    app.deferReads();
    await act(async () =>
        app.writes[0].reply.resolve(
            Response.json({ placement: "filed", processingStale: true }),
        ),
    );
    await waitFor(() => expect(app.reads).toHaveLength(1));
    app.switchItem();
    await waitFor(() => expect(app.reads).toHaveLength(2));
    const saved = projection({ filed: [child] });
    app.setProcessing(saved);
    await act(async () => {
        for (const read of app.reads)
            read.resolve(Response.json({ processing: saved }));
    });
    await waitFor(() => {
        const row = within(listRow("Planning session"));
        expect(row.getByText("Minutes")).toBeTruthy();
        expect(row.queryByText("Notes")).toBeNull();
    });
});

it("keeps the mobile list open when withdrawal finishes after Back", async () => {
    const app = open(projection({ shared: true, filed: [orgFolder] }), "org");
    fireEvent.click(
        await screen.findByRole("button", { name: "Remove from Design" }),
    );
    const withdraw = await screen.findByRole<HTMLButtonElement>("button", {
        name: "Take out of the Organization",
    });
    await waitFor(() => expect(withdraw.disabled).toBe(false));
    fireEvent.click(withdraw);
    await waitFor(() => expect(app.writes).toHaveLength(1));
    const back = screen
        .getAllByRole<HTMLButtonElement>("button", { name: "Design" })
        .find((button) => button.classList.contains("lg:hidden"));
    if (!back) throw new Error("Missing mobile Back button");
    fireEvent.click(back);
    expect(window.history.state.mobileView).toBe("list");
    app.setProcessing(projection());
    await act(async () =>
        app.writes[0].reply.resolve(
            Response.json({ placement: "unshared", processing: projection() }),
        ),
    );
    expect(window.history.state.mobileView).toBe("list");
    expect(window.location.search).toContain("folder=org-design");
});

it.each([
    true,
    false,
])("keeps an unfiling chip while the write saves (success %s)", async (success) => {
    const app = open(projection({ filed: [privateFolder] }));
    fireEvent.click(
        await screen.findByRole("button", { name: "Remove from Notes" }),
    );
    await waitFor(() => expect(app.writes).toHaveLength(1));
    const pending = screen.getByRole("button", { name: "Remove from Notes" });
    expect(chipContent(pending).getByRole("status").textContent).toBe(
        "Saving…",
    );
    await act(async () =>
        app.writes[0].reply.resolve(
            success
                ? Response.json({
                      placement: "removed",
                      processing: projection(),
                  })
                : new Response(null, { status: 500 }),
        ),
    );
    const chip = screen.queryByRole("button", { name: "Remove from Notes" });
    if (success) expect(chip).toBeNull();
    else {
        expect(chip).toBeTruthy();
        expect(chipContent(chip).queryByRole("status")).toBeNull();
    }
});

it("keeps the source and destination chips while a move saves", async () => {
    const app = open(projection({ filed: [privateFolder] }));
    await screen.findByRole("button", { name: "Remove from Notes" });
    const data = new Map([
        [RECORDING_DRAG_TYPE, item.id],
        [RECORDING_SOURCE_FOLDER_DRAG_TYPE, privateFolder.id],
        [RECORDING_SOURCE_SCOPE_DRAG_TYPES.personal, "personal"],
    ]);
    const notes = within(screen.getByRole("group", { name: "Notes" }));
    const expand = notes.queryByRole("button", { name: "Expand folder" });
    if (expand) fireEvent.click(expand);
    fireEvent.drop(
        screen.getByRole("button", { name: "Minutes, 0 recordings" }),
        {
            dataTransfer: {
                types: [...data.keys()],
                getData: (key: string) => data.get(key) ?? "",
            },
        },
    );
    await waitFor(() => expect(app.writes[0]?.method).toBe("PATCH"));
    for (const name of ["Notes", "Minutes"]) {
        const pending = screen.getByRole("button", {
            name: `Remove from ${name}`,
        });
        expect(chipContent(pending).getByRole("status").textContent).toBe(
            "Saving…",
        );
    }
    const saved = projection({ filed: [child] });
    await act(async () =>
        app.writes[0].reply.resolve(
            Response.json({ placement: "filed", processing: saved }),
        ),
    );
    expect(
        screen.queryByRole("button", { name: "Remove from Notes" }),
    ).toBeNull();
    expect(
        screen.getByRole("button", { name: "Remove from Minutes" }),
    ).toBeTruthy();
});

it("still warns before publication when a pending restricted removal fails", async () => {
    const app = open(projection({ filed: [restricted] }));
    fireEvent.click(
        await screen.findByRole("button", { name: /Remove from .*Restricted/ }),
    );
    await waitFor(() => expect(app.writes[0]?.method).toBe("DELETE"));
    await file("Design");
    expect(
        await screen.findByRole("alertdialog", {
            name: "Share with the whole Organization?",
        }),
    ).toBeTruthy();
    await act(async () =>
        app.writes[0].reply.resolve(new Response(null, { status: 500 })),
    );
    expect(app.writes).toHaveLength(1);
    expect(
        screen.getByRole("alertdialog", {
            name: "Share with the whole Organization?",
        }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
        await screen.findByRole("button", { name: /Remove from .*Restricted/ }),
    ).toBeTruthy();
});

it("preserves a settled filing across an older router snapshot and an out-of-order folder read", async () => {
    const app = open();
    app.deferDashboard();
    await file("Notes");
    await waitFor(() => expect(app.writes).toHaveLength(1));
    const saved = projection({ filed: [privateFolder] });
    await act(async () =>
        app.writes[0].reply.resolve(
            Response.json({ placement: "filed", processing: saved }),
        ),
    );
    expect(app.dashboardReads).toHaveLength(1);
    app.switchItem();
    app.receiveRouterSnapshot(folderSnapshot([]));
    expect(within(listRow("Planning session")).getByText("Notes")).toBeTruthy();
    await waitFor(() => expect(app.dashboardReads).toHaveLength(2));
    await act(async () =>
        app.dashboardReads[1].resolve(
            Response.json(folderSnapshot([privateFolder])),
        ),
    );
    await act(async () =>
        app.dashboardReads[0].resolve(Response.json(folderSnapshot([]))),
    );
    expect(within(listRow("Planning session")).getByText("Notes")).toBeTruthy();
    app.receiveRouterSnapshot(folderSnapshot([]));
    expect(within(listRow("Planning session")).getByText("Notes")).toBeTruthy();
    await waitFor(() => expect(app.dashboardReads).toHaveLength(3));
    await act(async () =>
        app.dashboardReads[2].resolve(
            Response.json(folderSnapshot([privateFolder])),
        ),
    );
});

it("keeps the received item's successfully removed chip gone until the dashboard confirms it", async () => {
    const app = open(projection({ filed: [privateFolder] }), "received");
    app.deferDashboard();
    fireEvent.click(
        await screen.findByRole("button", { name: "Remove from Notes" }),
    );
    await waitFor(() => expect(app.writes[0]?.method).toBe("DELETE"));
    expect(
        chipContent(
            screen.getByRole("button", { name: "Remove from Notes" }),
        ).getByRole("status").textContent,
    ).toBe("Saving…");
    await act(async () =>
        app.writes[0].reply.resolve(
            Response.json({ placement: "removed", processing: null }),
        ),
    );
    expect(
        screen.queryByRole("button", { name: "Remove from Notes" }),
    ).toBeNull();
    app.receiveRouterSnapshot(folderSnapshot([privateFolder]));
    expect(
        screen.queryByRole("button", { name: "Remove from Notes" }),
    ).toBeNull();
    await waitFor(() => expect(app.dashboardReads).toHaveLength(2));
    await act(async () =>
        app.dashboardReads[1].resolve(Response.json(folderSnapshot([]))),
    );
    expect(
        screen.queryByRole("button", { name: "Remove from Notes" }),
    ).toBeNull();
});
