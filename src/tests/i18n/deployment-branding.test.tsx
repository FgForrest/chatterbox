// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { IntlProvider } from "use-intl/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductNameProvider } from "@/components/product-name-provider";
import type { AppLocale } from "@/lib/i18n/config";
import { messagesForLocale } from "@/lib/i18n/messages";
import { processingFixture } from "@/tests/pipeline/processing-fixture";

const { envState, serverState } = vi.hoisted(() => ({
    envState: {
        IS_HOSTED: false,
        DOCS_REPOSITORY: "example/project",
    },
    serverState: { locale: "en" as "en" | "cs-CZ" },
}));

vi.mock("@/lib/env", () => ({ env: envState }));

vi.mock("next-intl/server", () => ({
    getLocale: async () => serverState.locale,
    getExtracted:
        async () => (message: string, values?: Record<string, string>) => {
            let translated = message;
            for (const [key, value] of Object.entries(values ?? {})) {
                translated = translated.replaceAll(`{${key}}`, value);
            }
            return translated;
        },
}));

vi.mock("fumadocs-ui/layouts/docs", () => ({
    DocsLayout: ({
        children,
        nav,
    }: {
        children: ReactNode;
        nav: { title: ReactNode };
    }) => (
        <div>
            <span data-testid="docs-title">{nav.title}</span>
            {children}
        </div>
    ),
}));

vi.mock("fumadocs-ui/provider/next", () => ({
    RootProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/lib/source", () => ({
    source: { getPageTree: () => ({ name: "Docs", children: [] }) },
}));

vi.mock("@/components/help/docs-image", () => ({
    DocsImage: () => null,
}));

vi.mock("@/hooks/use-settings", () => ({
    useSettings: () => ({
        isLoadingSettings: false,
        isSavingSettings: false,
        setIsLoadingSettings: vi.fn(),
        debouncedSave: vi.fn(),
    }),
}));

vi.mock("@/hooks/use-transcription-summary", () => ({
    useTranscriptionSummary: () => ({
        summaryData: null,
        isSummarizing: false,
        summaryProgress: null,
        summaryElapsedMs: 0,
        summaryExpanded: true,
        setSummaryExpanded: vi.fn(),
        summaryPreset: "general",
        setSummaryPreset: vi.fn(),
        summaryPromptOptions: [{ id: "general", name: "General" }],
        handleSummarize: vi.fn(),
        handleDeleteSummary: vi.fn(),
    }),
}));

vi.mock("@/components/dashboard/transcript-view", () => ({
    TranscriptView: () => <div>Transcript</div>,
}));

vi.mock("@/components/people/speaker-tags", () => ({
    SpeakerTags: () => null,
    confirmedAttributions: () => ({}),
}));

vi.mock("@/components/dashboard/transcribe-in-browser-button", () => ({
    TranscribeInBrowserButton: () => null,
}));

vi.mock("@/components/dashboard/markdown-actions", () => ({
    MarkdownActions: () => null,
}));

vi.mock("@/components/integrations/google-connection-panel", () => ({
    GoogleConnectionPanel: () => null,
}));

vi.mock("@/hooks/use-google-connection", () => ({
    useGoogleConnection: () => ({ state: null, refresh: vi.fn() }),
}));

vi.mock("@/components/help/help-button", () => ({
    HelpLink: () => null,
}));

import DocsRootLayout from "@/app/(docs)/layout";
import { FolderExportActions } from "@/components/dashboard/folder-export-actions";
import { TranscriptionPanel } from "@/components/dashboard/transcription-panel";
import { PlaudConnectTabs } from "@/components/plaud-connect-tabs";
import { EraseRecordingMenu } from "@/components/recordings/erase-recording-menu";
import { StorageSection } from "@/components/settings-sections/storage-section";
import { SyncSection } from "@/components/settings-sections/sync-section";
import { deploymentProductName } from "@/lib/deployment-brand";
import { managedFolderDescription } from "@/lib/folder-exports/drive-provider";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";

interface BrandWrapperProps {
    children: ReactNode;
    isHosted: boolean;
    locale: AppLocale;
}

function BrandWrapper({ children, isHosted, locale }: BrandWrapperProps) {
    return (
        <IntlProvider locale={locale} messages={messagesForLocale(locale)}>
            <ProductNameProvider isHosted={isHosted}>
                {children}
            </ProductNameProvider>
        </IntlProvider>
    );
}

function renderFor(ui: ReactElement, isHosted: boolean, locale: AppLocale) {
    return render(ui, {
        wrapper: ({ children }) => (
            <BrandWrapper isHosted={isHosted} locale={locale}>
                {children}
            </BrandWrapper>
        ),
    });
}

const cases = [
    [false, "en", "Chatterbox"],
    [false, "cs-CZ", "Klepna"],
    [true, "en", "Riffado"],
    [true, "cs-CZ", "Riffado"],
] as const;

function completedProcessing(): ItemProcessingPresentation {
    const at = "2026-10-16T10:00:00.000Z";
    return processingFixture({
        itemId: "recording-1",
        kind: "audio",
        legacy: false,
        manualOnly: false,
        phases: {
            categorize: { state: "done", generation: 1, at },
            transcribe: { state: "done", generation: 1, at },
            learn: { state: "done", generation: 1, at },
            summary: { state: "done", generation: 1, at },
            share: { state: "waiting", generation: 1, at },
        },
        profile: null,
        placements: [],
        intents: [
            {
                folderId: "folder-1",
                name: "Team",
                path: "Organization › Team",
                confirmationRequired: true,
                confirmed: false,
            },
        ],
        outputs: { transcript: true, learn: true, summary: true },
        processAgain: false,
        processAgainReason: null,
        learnFindingsWaiting: 0,
        taskReviewWaiting: 0,
        jobs: { transcription: null, summary: null },
        failures: [],
    });
}

describe.each(
    cases,
)("deployment branding (hosted=%s, locale=%s)", (isHosted, locale, expectedName) => {
    beforeEach(() => {
        envState.IS_HOSTED = isHosted;
        serverState.locale = locale;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url.includes("/api/settings/storage")) {
                    return Response.json({
                        storageType: "local",
                        usedBytes: 0,
                        recordingCount: 0,
                        totalDurationMs: 0,
                        largest: [],
                        diskFreeBytes: null,
                        quotaBytes: null,
                    });
                }
                if (url.endsWith("/exports")) {
                    return Response.json({ configured: [], applicableIds: [] });
                }
                return Response.json({});
            }),
        );
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("renders the transcript source label", () => {
        renderFor(
            <TranscriptionPanel
                recording={{
                    id: "recording-1",
                    filename: "Meeting.ogg",
                    duration: 60_000,
                    filesize: 1024,
                    startTime: new Date(0).toISOString(),
                    deviceSn: "local",
                }}
                transcripts={[
                    {
                        source: "riffado",
                        text: "Transcript",
                        provider: "openai",
                        model: "whisper-1",
                    },
                ]}
                isTranscribing={false}
                onTranscribe={vi.fn()}
                processing={completedProcessing()}
            />,
            isHosted,
            locale,
        );

        expect(screen.getAllByText(expectedName).length).toBeGreaterThan(0);
    });

    it("renders the storage hints", async () => {
        renderFor(<StorageSection />, isHosted, locale);

        await waitFor(() => {
            expect(
                screen.getAllByText(new RegExp(expectedName)).length,
            ).toBeGreaterThan(0);
        });
    });

    it("renders the erase-recording description", () => {
        renderFor(
            <EraseRecordingMenu
                recording={{
                    id: "recording-1",
                    filename: "Meeting.ogg",
                    duration: 60_000,
                    filesize: 1024,
                    startTime: new Date(0).toISOString(),
                    deviceSn: "local",
                }}
                onDeleteLocal={vi.fn()}
                onChanged={vi.fn()}
            />,
            isHosted,
            locale,
        );

        fireEvent.pointerDown(
            screen.getByRole("button", {
                name: "Erase recording artifacts",
            }),
            { button: 0, ctrlKey: false, pointerType: "mouse" },
        );
        fireEvent.click(
            screen.getByRole("menuitem", {
                name: "Delete all local data",
            }),
        );

        expect(
            screen.getAllByText(new RegExp(expectedName)).length,
        ).toBeGreaterThan(0);
    });

    it("renders the docs title", async () => {
        const layout = await DocsRootLayout({ children: <div>Page</div> });
        render(layout);

        expect(screen.getByTestId("docs-title").textContent).toBe(
            `${expectedName} Docs`,
        );
    });

    it("renders the sync description", () => {
        renderFor(<SyncSection />, isHosted, locale);

        expect(
            screen.getAllByText(new RegExp(expectedName)).length,
        ).toBeGreaterThan(0);
    });

    it("renders the Plaud connector hint", () => {
        renderFor(<PlaudConnectTabs onConnected={vi.fn()} />, isHosted, locale);

        expect(
            screen.getAllByText(new RegExp(expectedName)).length,
        ).toBeGreaterThan(0);
    });

    it("renders the Google Drive export hint", async () => {
        window.history.replaceState(null, "", "/");
        renderFor(
            <FolderExportActions
                folder={{
                    id: "folder-1",
                    parentId: null,
                    name: "Team",
                    kind: "custom",
                    sortOrder: 0,
                    scope: "personal",
                    version: 1,
                }}
                providers={{
                    filesystem: false,
                    googleDrive: true,
                    mail: false,
                }}
                privateTree
                reopen="form"
            />,
            isHosted,
            locale,
        );

        expect(
            await screen.findByText(new RegExp(`^${expectedName} `)),
        ).toBeTruthy();
    });

    it("renders the Drive managed-folder description", () => {
        render(
            <p>{managedFolderDescription(deploymentProductName(locale))}</p>,
        );

        expect(screen.getByText(new RegExp(expectedName))).toBeTruthy();
    });
});
