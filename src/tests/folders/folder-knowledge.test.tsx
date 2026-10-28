// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type * as NextIntl from "next-intl";
import type { ComponentProps } from "react";
import type { TranslationValues } from "use-intl/core";
import { IntlProvider, useTranslations } from "use-intl/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    FolderKnowledgePanel,
    KnowledgePanel,
} from "@/components/dashboard/folder-knowledge-panel";
import { LibraryLocationHeader } from "@/components/dashboard/library-location-header";
import { transcriptSpeakerTags } from "@/components/dashboard/transcription-panel";
import { Workstation } from "@/components/dashboard/workstation";
import type { useOrgEvents } from "@/hooks/use-org-events";
import {
    messagesForLocale,
    translatedSourceMessage,
} from "@/lib/i18n/messages";
import {
    FOLDER_KNOWLEDGE_PAGE_SIZE,
    type FolderKnowledgeResponse,
} from "@/lib/knowledge/folder-knowledge";
import { INITIAL_SETTINGS_DEFAULTS } from "@/lib/settings/initial-settings";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

const mocks = vi.hoisted(() => ({
    orgEvents: vi.fn<typeof useOrgEvents>(),
    refresh: vi.fn(),
    fetch: vi.fn<typeof fetch>(),
}));
vi.mock("next-intl", async (importOriginal) => {
    const original = await importOriginal<typeof NextIntl>();
    return {
        ...original,
        useExtracted: () => {
            const translate = useTranslations();
            const ids = new Map(
                Object.entries(messagesForLocale("en")).map(([id, source]) => [
                    source,
                    id,
                ]),
            );
            return (
                message:
                    | string
                    | Parameters<ReturnType<typeof NextIntl.useExtracted>>[0],
                values?: TranslationValues,
            ) => {
                if (typeof message === "string")
                    return translate(ids.get(message) ?? message, values);
                return translate(
                    message.id ?? ids.get(message.message) ?? message.message,
                    message.values,
                );
            };
        },
    };
});
vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: mocks.refresh }),
    useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("posthog-js", () => ({ default: { __loaded: false } }));
vi.mock("sonner", () => ({
    toast: {
        error: vi.fn(),
        success: vi.fn(),
        custom: vi.fn(),
        dismiss: vi.fn(),
    },
}));
vi.mock("@/components/app-chrome-provider", () => ({
    useAppChrome: () => ({
        settingsOpen: false,
        onboardingOpen: false,
        paletteOpen: false,
        shortcutsOpen: false,
        theme: "light",
        isAutoSyncing: false,
        lastSyncResult: null,
        setSettingsOpen: vi.fn(),
        setPaletteOpen: vi.fn(),
        setShortcutsOpen: vi.fn(),
        setTheme: vi.fn(),
        manualSync: vi.fn(),
        handleReconnected: vi.fn(),
    }),
}));
vi.mock("@/hooks/use-org-events", () => ({ useOrgEvents: mocks.orgEvents }));
vi.mock("@/hooks/use-share-refusal", () => ({
    useShareRefusal: () => vi.fn(),
}));
vi.mock("@/hooks/use-transcribe-queue", () => ({
    useTranscribeQueue: () => ({
        inFlightActions: new Map(),
        observeTranscriptionById: vi.fn(),
        transcribeById: vi.fn(),
    }),
}));
vi.mock("@/hooks/use-upload-queue", () => ({
    useUploadQueue: () => ({
        isUploading: false,
        pendingUploads: [],
        uploadInputRef: { current: null },
        handleUpload: vi.fn(),
        selectedFile: null,
        confirmUpload: vi.fn(),
        cancelUpload: vi.fn(),
        triggerUpload: vi.fn(),
    }),
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("@/components/dashboard/folder-tree", () => ({
    FolderTree: () => null,
}));
vi.mock("@/components/dashboard/folder-settings-panel", () => ({
    FolderSettingsPanel: () => null,
}));
vi.mock("@/components/dashboard/first-level-folder-dialog", () => ({
    FirstLevelFolderDialog: () => null,
}));
vi.mock("@/components/dashboard/command-palette", () => ({
    CommandPalette: () => null,
}));
vi.mock("@/components/dashboard/trial-banner", () => ({
    TrialBanner: () => null,
}));
vi.mock("@/components/dashboard/plaud-reconnect-banner", () => ({
    PlaudReconnectBanner: () => null,
}));
vi.mock("@/components/dashboard/upload-dialog", () => ({
    UploadDialog: () => null,
    uploadFolderOptions: () => [],
    uploadFolderParents: () => [],
}));
vi.mock("@/components/dashboard/workstation-detail-pane", () => ({
    WorkstationDetailPane: () => <div>Item detail</div>,
}));
vi.mock("@/components/mail/mail-detail-pane", () => ({
    MailDetailPane: () => <div>Mail detail</div>,
}));
vi.mock("@/components/dashboard/recording-list", () => ({
    RecordingList: ({
        header,
        navigationContent,
        recordings,
        onSelect,
    }: ComponentProps<typeof RecordingListType>) => (
        <section aria-label="Item list">
            {header?.(recordings.length)}
            {navigationContent}
            {recordings.map((recording) => (
                <button
                    key={recording.id}
                    type="button"
                    onClick={() => onSelect(recording)}
                >
                    {recording.filename}
                </button>
            ))}
        </section>
    ),
}));

import type { RecordingList as RecordingListType } from "@/components/dashboard/recording-list";

const root: RecordingFolder = {
    id: "private-root",
    name: "Private",
    parentId: null,
    kind: "private",
    scope: "personal",
    sortOrder: 0,
    version: 0,
};
const folder: RecordingFolder = {
    ...root,
    id: "folder",
    name: "Velnaro",
    kind: "custom",
    parentId: root.id,
};
const org: RecordingFolder = { ...folder, id: "org", scope: "org" };
const folders = [root, folder, org];
const recording: Recording = {
    id: "item",
    filename: "Invented item",
    deviceSn: "test",
    duration: 100,
    filesize: 100,
    startTime: "2026-10-01T10:00:00Z",
};
const metadata = {
    folder: {
        id: folder.id,
        name: folder.name,
        scope: folder.scope,
        isRoot: false,
    },
    itemCount: 4,
    subfolderCount: 2,
};

function response(tab: string): FolderKnowledgeResponse {
    if (tab === "models")
        return {
            ...metadata,
            tab,
            language: null,
            transcription: {
                limit: 500,
                total: 503,
                sent: 500,
                terms: Array.from({ length: 8 }, (_, index) => ({
                    text: `Velnaro ${index}`,
                    soundsLike: [],
                    reason: {
                        recorder: index === 0,
                        folderUses: 3,
                        ownerRecent: 2,
                        ownerUses: 4,
                        mishearings: 1,
                    },
                })),
                belowCut: [
                    {
                        text: "Below limit",
                        soundsLike: [],
                        reason: {
                            recorder: false,
                            folderUses: 0,
                            ownerRecent: 0,
                            ownerUses: 1,
                            mishearings: 0,
                        },
                    },
                ],
            },
            correction: {
                count: 500,
                limit: 500,
                previewCount: 5,
                preview: 'ALMANAC (JSON):\n{"people":[],"things":[]}',
            },
        };
    if (tab === "facts")
        return {
            ...metadata,
            tab,
            total: 1,
            nextOffset: null,
            facts: [
                {
                    id: "fact",
                    factId: "fact",
                    subject: "Velnaro",
                    relationKey: "works_on",
                    relationLabel: "works on",
                    object: "Nulvaro",
                    scope: "org",
                    itemId: "item",
                    itemTitle: "Invented evidence",
                    itemDate: "2026-10-01T10:00:00Z",
                },
            ],
        };
    if (tab === "corrections")
        return {
            ...metadata,
            tab,
            total: 1,
            nextOffset: null,
            corrections: [
                {
                    id: "correction",
                    heard: "nulvo",
                    targetId: "thing",
                    targetName: "Nulvaro",
                    scope: "org",
                    useCount: 3,
                    itemCount: 2,
                    lastAt: "2026-10-01T10:00:00Z",
                },
            ],
        };
    return {
        ...metadata,
        tab: tab === "things" ? "things" : "people",
        total: 1,
        nextOffset: null,
        records: [
            {
                id: "person",
                name: tab === "things" ? "Nulvaro" : "Vesna Kulra",
                typeKey: "project",
                typeLabel: "Project",
                hasEmail: false,
                scope: "org",
                itemCount: 3,
                lastAt: "2026-10-01T10:00:00Z",
            },
        ],
    };
}

beforeEach(() => {
    window.history.replaceState({}, "", "/dashboard?folder=folder");
    localStorage.clear();
    mocks.orgEvents.mockReset();
    mocks.fetch.mockReset();
    mocks.fetch.mockImplementation(async (input) => {
        const tab =
            new URL(String(input), "http://localhost").searchParams.get(
                "tab",
            ) ?? "people";
        return new Response(JSON.stringify(response(tab)));
    });
    vi.stubGlobal("fetch", mocks.fetch);
    vi.stubGlobal("matchMedia", () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    }));
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("folder knowledge header", () => {
    it.each([
        "rail",
        "walk",
    ] as const)("offers read-only knowledge to a member in the %s layout", (variant) => {
        const open = vi.fn();
        render(
            <LibraryLocationHeader
                variant={variant}
                organization={{ folders, assignments: [] }}
                recordings={[]}
                folder={org}
                onNavigate={vi.fn()}
                onSettings={vi.fn()}
                onKnowledge={open}
                onNewFolder={vi.fn()}
                onAssign={vi.fn()}
                onMove={vi.fn()}
                canCurate={false}
            />,
        );
        const button = screen.getByRole("button", { name: "Knowledge" });
        expect(button.className).toContain("text-organization");
        fireEvent.click(button);
        expect(open).toHaveBeenCalledWith(org);
    });
});

describe("folder knowledge panel", () => {
    it("loads only the active tab, reuses loaded tabs and exposes no editing actions", async () => {
        const back = vi.fn();
        render(<FolderKnowledgePanel folder={folder} onBack={back} />);
        expect(await screen.findByText("Vesna Kulra")).toBeTruthy();
        expect(screen.getByText("no e-mail")).toBeTruthy();
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        expect(
            screen.getAllByRole("tab").map((tab) => tab.textContent),
        ).toEqual([
            "People",
            "Things",
            "Corrections",
            "Facts",
            "What the models receive",
        ]);
        fireEvent.click(screen.getByRole("tab", { name: "Things" }));
        expect(await screen.findByText("Nulvaro")).toBeTruthy();
        fireEvent.click(screen.getByRole("tab", { name: "Corrections" }));
        expect(await screen.findByText("nulvo")).toBeTruthy();
        fireEvent.click(screen.getByRole("tab", { name: "Facts" }));
        expect(await screen.findByText("Invented evidence")).toBeTruthy();
        fireEvent.click(screen.getByRole("tab", { name: "People" }));
        expect(await screen.findByText("Vesna Kulra")).toBeTruthy();
        expect(mocks.fetch).toHaveBeenCalledTimes(4);
        expect(
            screen.queryByRole("button", { name: /Merge|Delete|Edit/ }),
        ).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Back" }));
        expect(back).toHaveBeenCalledOnce();
    });
    it("shows ranking reasons, omitted terms, the cut line, exact correction JSON and root context note", async () => {
        mocks.fetch.mockImplementation(
            async () =>
                new Response(
                    JSON.stringify({
                        ...response("models"),
                        folder: { ...metadata.folder, isRoot: true },
                    }),
                ),
        );
        render(<FolderKnowledgePanel folder={root} onBack={vi.fn()} />);
        fireEvent.click(
            screen.getByRole("tab", { name: "What the models receive" }),
        );
        expect(await screen.findByText("Below limit")).toBeTruthy();
        expect(
            screen.getByText(/Recording owner · 3× in this folder/),
        ).toBeTruthy();
        expect(screen.getByText(/… 492 more/)).toBeTruthy();
        expect(screen.getByText(/500-term cut line/)).toBeTruthy();
        expect(screen.getByText(/ALMANAC \(JSON\):/).textContent).toBe(
            'ALMANAC (JSON):\n{"people":[],"things":[]}',
        );
        expect(
            screen.getByText(/Items filed directly in a root folder/),
        ).toBeTruthy();
        expect(
            screen.getByText(/Speaker names are filled in afterwards/),
        ).toBeTruthy();
        expect(screen.getByText(/without a folder filter/)).toBeTruthy();
    });
    it.each([
        0, 1, 500,
    ])("hides the cut line for %s terms and uses the pinned language note", async (total) => {
        const models = response("models");
        if (models.tab !== "models") throw new Error("Expected models");
        mocks.fetch.mockImplementation(
            async () =>
                new Response(
                    JSON.stringify({
                        ...models,
                        language: "cs",
                        transcription: {
                            ...models.transcription,
                            total,
                            sent: total,
                            belowCut: [],
                            terms: models.transcription.terms.slice(
                                0,
                                Math.min(total, 8),
                            ),
                        },
                    }),
                ),
        );
        render(<FolderKnowledgePanel folder={folder} onBack={vi.fn()} />);
        fireEvent.click(
            screen.getByRole("tab", { name: "What the models receive" }),
        );
        await screen.findByText(
            "Transcription language from the folder's audio profile: cs.",
        );
        expect(screen.queryByText(/Language is unknown/)).toBeNull();
        expect(screen.queryByText(/500-term cut line/)).toBeNull();
        expect(
            screen.getByText(`${total} of ${total} terms sent`),
        ).toBeTruthy();
    });
    it.each([
        [1, "1 term", "1 record"],
        [3, "3 terms", "3 records"],
    ] as const)("uses response limits with limit %s", async (limit, terms, records) => {
        const models = response("models");
        if (models.tab !== "models") throw new Error("Expected models");
        mocks.fetch.mockImplementation(
            async () =>
                new Response(
                    JSON.stringify({
                        ...models,
                        transcription: { ...models.transcription, limit },
                        correction: { ...models.correction, limit },
                    }),
                ),
        );
        render(<FolderKnowledgePanel folder={folder} onBack={vi.fn()} />);
        fireEvent.click(screen.getAllByRole("tab")[4]);
        const below = await screen.findByText("Below limit");
        expect(below.parentElement?.firstElementChild?.textContent).toBe(
            String(limit + 1),
        );
        expect(screen.getByText(new RegExp(`Up to ${terms}\\.`))).toBeTruthy();
        expect(
            screen.getByText(new RegExp(`Up to ${records}\\.`)),
        ).toBeTruthy();
        expect(
            screen.getByText(
                `${limit}-term cut line: transcription does not receive terms below this limit.`,
            ),
        ).toBeTruthy();
        expect(screen.getByRole("heading", { name: "MCP" })).toBeTruthy();
    });
    it.each([
        [1, "1 výraz", "1 záznam"],
        [3, "3 výrazy", "3 záznamy"],
        [7, "7 výrazů", "7 záznamů"],
    ] as const)("uses Czech plurals with limit %s", (limit, terms, records) => {
        expect(
            translatedSourceMessage(
                "cs-CZ",
                "Up to {limit, plural, one {# term} other {# terms}}. The folder only ranks them; it never filters the Almanac.",
                { limit },
            ),
        ).toBe(`Až ${terms}. Složka je jen řadí, nikdy nefiltruje Almanach.`);
        expect(
            translatedSourceMessage(
                "cs-CZ",
                "Names, aliases and mishearings, no facts. Transcript mentions come first, then folder usage. Up to {limit, plural, one {# record} other {# records}}.",
                { limit },
            ),
        ).toContain(`Až ${records}.`);
    });
    it("renders the recording owner reason in Czech", async () => {
        render(
            <IntlProvider
                locale="cs-CZ"
                messages={messagesForLocale("cs-CZ")}
                timeZone="UTC"
            >
                <FolderKnowledgePanel folder={folder} onBack={vi.fn()} />
            </IntlProvider>,
        );
        fireEvent.click(
            screen.getByRole("tab", { name: "Co dostanou modely" }),
        );
        expect(
            await screen.findByText(/vlastník nahrávky · 3× ve složce/),
        ).toBeTruthy();
    });
    it("returns to the previous page using the shared page size", async () => {
        mocks.fetch.mockImplementation(async (input) => {
            const offset = Number(
                new URL(String(input), "http://localhost").searchParams.get(
                    "offset",
                ),
            );
            return new Response(
                JSON.stringify({
                    ...response("people"),
                    nextOffset:
                        offset === 0 ? FOLDER_KNOWLEDGE_PAGE_SIZE : null,
                }),
            );
        });
        render(<FolderKnowledgePanel folder={folder} onBack={vi.fn()} />);
        await screen.findByText("Vesna Kulra");
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        await screen.findByText("Vesna Kulra");
        expect(String(mocks.fetch.mock.lastCall?.[0])).toContain(
            `offset=${FOLDER_KNOWLEDGE_PAGE_SIZE}`,
        );
        fireEvent.click(screen.getByRole("button", { name: "Previous" }));
        await screen.findByText("Vesna Kulra");
        expect(
            (
                screen.getByRole("button", {
                    name: "Previous",
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
        expect(
            (screen.getByRole("button", { name: "Next" }) as HTMLButtonElement)
                .disabled,
        ).toBe(false);
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });
    it("uses custom vocabulary labels and includes the Organization icon", async () => {
        const things = response("things");
        if (!("records" in things)) throw new Error("Expected things");
        mocks.fetch.mockImplementation(
            async () =>
                new Response(
                    JSON.stringify({
                        ...things,
                        records: things.records.map((record) => ({
                            ...record,
                            typeKey: "org:velnaro-kind",
                            typeLabel: "Velnaro kind",
                        })),
                    }),
                ),
        );
        render(<FolderKnowledgePanel folder={folder} onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole("tab", { name: "Things" }));
        await screen.findByText("Velnaro kind");
        expect(
            screen.getByText("Organization").querySelector("svg.lucide-users"),
        ).toBeTruthy();
    });
    it("supports keyboard tab navigation", async () => {
        render(<FolderKnowledgePanel folder={folder} onBack={vi.fn()} />);
        await screen.findByText("Vesna Kulra");
        fireEvent.keyDown(screen.getByRole("tab", { name: "People" }), {
            key: "End",
        });
        expect(
            screen
                .getByRole("tab", { name: "What the models receive" })
                .getAttribute("aria-selected"),
        ).toBe("true");
        await screen.findByText("Below limit");
    });
});

const workstationProps: ComponentProps<typeof Workstation> = {
    userId: "member",
    recordings: [recording],
    transcriptions: new Map(),
    initialSettings: INITIAL_SETTINGS_DEFAULTS,
    plaudNeedsReconnect: false,
    isHosted: false,
    exportProviders: { googleDrive: false, filesystem: false, mail: false },
    initialFolderOrganization: {
        folders,
        assignments: [{ recordingId: recording.id, folderId: folder.id }],
    },
};

it.each([
    "en",
    "cs-CZ",
] as const)("uses the transcript chips' zero-based speaker labels in Knowledge (%s)", async (locale) => {
    const turns = Array.from({ length: 4 }, (_, index) => ({
        speaker: `speaker_${index}`,
        text: "Hello",
        startMs: index * 1000,
        endMs: (index + 1) * 1000,
    }));
    const chips = transcriptSpeakerTags({
        source: "riffado",
        text: "Hello",
        turns,
    });
    mocks.fetch.mockResolvedValue(
        Response.json({
            tab: "speakers",
            total: 4,
            nextOffset: null,
            itemCount: 1,
            subfolderCount: 0,
            item: {
                id: "item",
                kind: "audio",
                title: "Invented item",
                canReview: false,
                speakers: turns.map((turn) => ({
                    label: turn.speaker,
                    name: null,
                    status: null,
                    source: null,
                    unknown: false,
                })),
                newRecordIds: [],
                counts: {
                    speakers: 4,
                    people: 0,
                    things: 0,
                    corrections: 0,
                    facts: 0,
                    models: 5,
                },
                learn: null,
                review: null,
            },
        }),
    );
    render(
        <IntlProvider
            locale={locale}
            messages={messagesForLocale(locale)}
            timeZone="UTC"
        >
            <KnowledgePanel
                scope={{
                    kind: "item",
                    itemId: "item",
                    itemKind: "audio",
                    title: "Invented item",
                }}
                onBack={vi.fn()}
            />
        </IntlProvider>,
    );
    for (const [index, chip] of chips.entries()) {
        expect(chip.label).toBe(`Speaker ${index}`);
        expect(
            await screen.findByRole("cell", { name: chip.label }),
        ).toBeTruthy();
    }
});

describe("dashboard folder knowledge navigation", () => {
    it("toggles Knowledge closed, restores the list and item, and can reopen it", async () => {
        render(<Workstation {...workstationProps} />);
        const push = vi.spyOn(window.history, "pushState");
        try {
            const knowledgeButton = () =>
                screen.getAllByRole("button", { name: "Knowledge" })[0];
            expect(knowledgeButton().getAttribute("aria-pressed")).toBe(
                "false",
            );
            fireEvent.click(knowledgeButton());
            await screen.findByText("Vesna Kulra");
            expect(knowledgeButton().getAttribute("aria-pressed")).toBe("true");
            expect(window.location.search).toContain("knowledge=1");
            expect(screen.queryByText("Item detail")).toBeNull();
            expect(push).toHaveBeenCalledTimes(1);
            window.history.replaceState({}, "", window.location.href);
            fireEvent.click(knowledgeButton());
            expect(knowledgeButton().getAttribute("aria-pressed")).toBe(
                "false",
            );
            expect(
                screen.queryByRole("region", { name: "Folder knowledge" }),
            ).toBeNull();
            expect(window.location.search).not.toContain("knowledge");
            expect(window.history.state.mobileView).toBe("list");
            expect(
                screen.getByRole("region", { name: "Item list" }).parentElement
                    ?.className,
            ).not.toContain("hidden");
            expect(screen.getByText("Item detail")).toBeTruthy();
            expect(push).toHaveBeenCalledTimes(1);
            fireEvent.click(knowledgeButton());
            await screen.findByText("Vesna Kulra");
            expect(knowledgeButton().getAttribute("aria-pressed")).toBe("true");
            expect(push).toHaveBeenCalledTimes(2);
        } finally {
            push.mockRestore();
        }
    });
    it("keeps the active knowledge tab when the hidden Organization item changes", async () => {
        window.history.replaceState({}, "", "/dashboard?folder=org");
        const shared = { ...recording, view: "org" as const };
        render(
            <Workstation
                {...workstationProps}
                organizationLibrary={{
                    recordings: [shared],
                    transcriptions: new Map(),
                    transcriptVariants: new Map(),
                }}
                initialFolderOrganization={{
                    folders,
                    assignments: [
                        { recordingId: recording.id, folderId: org.id },
                    ],
                }}
            />,
        );
        fireEvent.click(
            screen.getAllByRole("button", { name: "Knowledge" })[0],
        );
        await screen.findByText("Vesna Kulra");
        fireEvent.click(screen.getByRole("tab", { name: "Facts" }));
        await screen.findByText("Invented evidence");
        act(() => {
            mocks.orgEvents.mock.lastCall?.[1]({
                type: "recording",
                recordingId: recording.id,
            });
        });
        expect(
            screen
                .getByRole("tab", { name: "Facts" })
                .getAttribute("aria-selected"),
        ).toBe("true");
        expect(await screen.findByText("Invented evidence")).toBeTruthy();
        expect(mocks.fetch).toHaveBeenCalledTimes(3);
    });
    it("keeps knowledge open when the selected item disappears during a refresh", async () => {
        const { rerender } = render(<Workstation {...workstationProps} />);
        fireEvent.click(
            screen.getAllByRole("button", { name: "Knowledge" })[0],
        );
        await screen.findByText("Vesna Kulra");
        rerender(<Workstation {...workstationProps} recordings={[]} />);
        expect(window.location.search).toContain("knowledge=1");
        expect(
            screen.getByRole("region", { name: "Folder knowledge" }),
        ).toBeTruthy();
    });
    it("replaces item detail, shows its own phone view, and Back restores the list", async () => {
        render(<Workstation {...workstationProps} />);
        expect(screen.getByText("Item detail")).toBeTruthy();
        fireEvent.click(
            screen.getAllByRole("button", { name: "Knowledge" })[0],
        );
        await screen.findByText("Vesna Kulra");
        expect(screen.queryByText("Item detail")).toBeNull();
        act(() => {
            window.history.replaceState(
                { mobileView: "list" },
                "",
                window.location.href,
            );
            window.dispatchEvent(new PopStateEvent("popstate"));
        });
        const listContainer = screen.getByRole("region", {
            name: "Item list",
            hidden: true,
        }).parentElement;
        expect(listContainer?.className).toContain("hidden");
        expect(window.location.search).toContain("knowledge=1");
        fireEvent.click(screen.getByRole("button", { name: "Back" }));
        expect(
            screen.queryByRole("region", { name: "Folder knowledge" }),
        ).toBeNull();
        expect(listContainer?.className).not.toContain("hidden");
        expect(window.location.search).not.toContain("knowledge");
        expect(screen.getByText("Item detail")).toBeTruthy();
    });
    it("opens a knowledge link in an empty folder and restores it through browser history", async () => {
        window.history.replaceState(
            {},
            "",
            "/dashboard?folder=folder&knowledge=1",
        );
        render(<Workstation {...workstationProps} recordings={[]} />);
        expect(await screen.findByText("Vesna Kulra")).toBeTruthy();
        act(() => {
            window.history.replaceState({}, "", "/dashboard?folder=folder");
            window.dispatchEvent(new PopStateEvent("popstate"));
        });
        expect(
            screen.queryByRole("region", { name: "Folder knowledge" }),
        ).toBeNull();
        act(() => {
            window.history.replaceState(
                {},
                "",
                "/dashboard?folder=folder&knowledge=1",
            );
            window.dispatchEvent(new PopStateEvent("popstate"));
        });
        await waitFor(() =>
            expect(
                screen.getByRole("region", { name: "Folder knowledge" }),
            ).toBeTruthy(),
        );
    });
    it("closes knowledge when an item is selected on desktop", async () => {
        render(<Workstation {...workstationProps} />);
        fireEvent.click(
            screen.getAllByRole("button", { name: "Knowledge" })[0],
        );
        await screen.findByText("Vesna Kulra");
        fireEvent.click(
            screen.getByRole("button", {
                name: recording.filename,
                hidden: true,
            }),
        );
        expect(
            screen.queryByRole("region", { name: "Folder knowledge" }),
        ).toBeNull();
        expect(screen.getByText("Item detail")).toBeTruthy();
    });
});

describe.each([
    "folder",
    "audio",
    "mail",
] as const)("shared Knowledge body for %s", (kind) => {
    function mount() {
        const back = vi.fn();
        const review = vi.fn();
        render(
            kind === "folder" ? (
                <FolderKnowledgePanel folder={folder} onBack={back} />
            ) : (
                <KnowledgePanel
                    scope={{
                        kind: "item",
                        itemId: "item",
                        itemKind: kind,
                        title: "Invented item",
                        view: "org",
                    }}
                    onBack={back}
                    onReview={review}
                />
            ),
        );
        return { back, review };
    }
    beforeEach(() => {
        mocks.fetch.mockImplementation(async (input) => {
            const tab =
                new URL(String(input), "http://localhost").searchParams.get(
                    "tab",
                ) ?? "people";
            return Response.json({
                ...response(tab === "speakers" ? "people" : tab),
                ...(kind !== "folder"
                    ? {
                          tab,
                          ...(tab === "speakers"
                              ? { total: 1, nextOffset: null }
                              : {}),
                          item: {
                              id: "item",
                              kind,
                              title: "Invented item",
                              canReview: true,
                              speakers: [
                                  {
                                      label: "speaker_0",
                                      name: "Vesna Kulra",
                                      status: "confirmed",
                                      source: "calendar",
                                      unknown: false,
                                  },
                              ],
                              newRecordIds: ["person"],
                              counts: {
                                  speakers: 1,
                                  people: 1,
                                  things: 1,
                                  corrections: 1,
                                  facts: 1,
                                  models: 5,
                              },
                              learn: {
                                  status: "ready",
                                  pending: 2,
                                  at: "2026-10-28T14:02:00Z",
                                  applied: 0,
                              },
                              review: null,
                          },
                      }
                    : {}),
            });
        });
    });
    it("uses the same tabs, active-tab cache, keyboard navigation and Back", async () => {
        const { back, review } = mount();
        await screen.findByText("Vesna Kulra");
        expect(String(mocks.fetch.mock.calls[0][0])).toContain(
            kind === "folder"
                ? "/api/folders/folder/knowledge"
                : "/api/items/item/knowledge",
        );
        if (kind !== "folder") {
            expect(String(mocks.fetch.mock.calls[0][0])).toContain("view=org");
            fireEvent.click(screen.getByRole("button", { name: "Review" }));
            expect(review).toHaveBeenCalledOnce();
        }
        fireEvent.click(screen.getByRole("tab", { name: /^Corrections/ }));
        await screen.findByText("nulvo");
        fireEvent.click(screen.getByRole("tab", { name: /^People/ }));
        await screen.findByText("Vesna Kulra");
        const reads = mocks.fetch.mock.calls.length;
        fireEvent.click(screen.getByRole("tab", { name: /^Corrections/ }));
        await screen.findByText("nulvo");
        expect(mocks.fetch).toHaveBeenCalledTimes(reads);
        fireEvent.keyDown(screen.getByRole("tab", { name: /^Corrections/ }), {
            key: "End",
        });
        if (kind === "mail")
            await screen.findByText(
                "The model receives the message text, with no Almanac.",
            );
        else await screen.findByText("Below limit");
        if (kind !== "folder")
            expect(
                screen.queryByText(/Transcription language from/),
            ).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Back" }));
        expect(back).toHaveBeenCalledOnce();
    });
    it("recovers an active-tab request after a failure", async () => {
        mocks.fetch.mockResolvedValueOnce(new Response("", { status: 503 }));
        mount();
        await screen.findByRole("alert");
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        await screen.findByText("Vesna Kulra");
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });
    if (kind !== "folder") {
        it("shows no Learn subtitle to recipients", async () => {
            mocks.fetch.mockResolvedValue(
                Response.json({
                    ...response("people"),
                    item: {
                        id: "item",
                        kind,
                        canReview: false,
                        modelContextAvailable: false,
                        speakers: [],
                        newRecordIds: [],
                        counts: {
                            people: 0,
                            things: 0,
                            corrections: 0,
                            facts: 0,
                            speakers: 0,
                            models: 0,
                        },
                        learn: null,
                        review: null,
                    },
                }),
            );
            render(
                <KnowledgePanel
                    scope={{
                        kind: "item",
                        itemId: "item",
                        itemKind: kind,
                        title: "Invented item",
                        view: "received",
                    }}
                    onBack={vi.fn()}
                />,
            );
            await screen.findByText("Vesna Kulra");
            expect(screen.queryByText(/Learn/)).toBeNull();
            expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
        });
        it.each([
            null,
            7,
        ])("keeps historical applied count %s accurate in the Knowledge subtitle", async (applied) => {
            mocks.fetch.mockImplementation(async () =>
                Response.json({
                    ...response("people"),
                    item: {
                        id: "item",
                        kind,
                        title: "Invented item",
                        canReview: false,
                        modelContextAvailable: true,
                        speakers: [],
                        newRecordIds: [],
                        counts: {
                            people: 1,
                            things: 0,
                            corrections: 0,
                            facts: 0,
                            speakers: 0,
                            models: 5,
                        },
                        learn: {
                            status: "finished",
                            pending: 0,
                            at: "2026-10-28T14:02:00Z",
                            applied,
                            skipped: null,
                            dismissed: null,
                        },
                        review: null,
                    },
                }),
            );
            mount();
            await screen.findByText(/Learn complete/);
            if (applied === null)
                expect(screen.queryByText(/changes? applied/)).toBeNull();
            else expect(screen.getByText(/7 changes applied/)).toBeTruthy();
            expect(
                screen.queryByRole("button", { name: "Re-learn" }),
            ).toBeNull();
        });
    }
});
