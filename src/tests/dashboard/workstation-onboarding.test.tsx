// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workstation } from "@/components/dashboard/workstation";
import { INITIAL_SETTINGS_DEFAULTS } from "@/lib/settings/initial-settings";

vi.mock("next-intl", () => ({
    useExtracted: () => (source: string) => source,
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("posthog-js", () => ({
    default: { __loaded: false, capture: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@/components/dashboard/command-palette", () => ({
    CommandPalette: () => null,
}));
vi.mock("@/components/dashboard/folder-recording-pane", () => ({
    FolderRecordingPane: () => null,
}));
vi.mock("@/components/dashboard/folder-tree", () => ({
    FolderTree: () => null,
}));
vi.mock("@/components/dashboard/plaud-reconnect-banner", () => ({
    PlaudReconnectBanner: () => null,
}));
vi.mock("@/components/dashboard/recording-list", () => ({
    RecordingList: () => null,
}));
vi.mock("@/components/dashboard/shortcuts-dialog", () => ({
    ShortcutsDialog: () => null,
}));
vi.mock("@/components/dashboard/trial-banner", () => ({
    TrialBanner: () => null,
}));
vi.mock("@/components/dashboard/upload-dialog", () => ({
    UploadDialog: () => null,
    uploadFolderOptions: () => [],
    uploadFolderParents: () => [],
}));
vi.mock("@/components/dashboard/workstation-detail-pane", () => ({
    WorkstationDetailPane: () => null,
}));
vi.mock("@/components/dashboard/workstation-empty-state", () => ({
    WorkstationEmptyState: () => null,
}));
vi.mock("@/components/dashboard/workstation-header", () => ({
    WorkstationHeader: () => null,
}));
vi.mock("@/components/mail/mail-detail-pane", () => ({
    MailDetailPane: () => null,
}));
vi.mock("@/components/settings-dialog", () => ({
    SettingsDialog: () => null,
}));
vi.mock("@/components/onboarding-dialog", () => ({
    OnboardingDialog: ({
        open,
        initialStep,
    }: {
        open: boolean;
        initialStep: string;
    }) => (
        <div data-testid="onboarding-dialog">
            {open ? `open:${initialStep}` : `closed:${initialStep}`}
        </div>
    ),
}));

vi.mock("@/hooks/use-auto-sync", () => ({
    useAutoSync: () => ({
        isAutoSyncing: false,
        lastSyncTime: null,
        nextSyncTime: null,
        lastSyncResult: null,
        manualSync: vi.fn().mockResolvedValue(undefined),
    }),
}));
vi.mock("@/hooks/use-google-connection", () => ({
    useGoogleConnectOutcome: vi.fn(),
}));
vi.mock("@/hooks/use-list-keyboard-nav", () => ({
    useListKeyboardNav: vi.fn(),
}));
vi.mock("@/hooks/use-org-events", () => ({ useOrgEvents: vi.fn() }));
vi.mock("@/hooks/use-share-refusal", () => ({
    useShareRefusal: () => vi.fn(),
}));
vi.mock("@/hooks/use-theme", () => ({
    useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
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

afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
    vi.clearAllMocks();
});

describe("workstation onboarding resume", () => {
    it("opens the setup wizard on Google from the resume query", async () => {
        window.history.replaceState({}, "", "/dashboard?onboarding=google");

        render(
            <Workstation
                recordings={[]}
                transcriptions={new Map()}
                initialSettings={{
                    ...INITIAL_SETTINGS_DEFAULTS,
                    onboardingCompleted: true,
                }}
                plaudNeedsReconnect={false}
                isHosted={false}
                onboardingCapabilities={{
                    googleConfigured: true,
                    mailAvailable: false,
                    mcpConnectorUrl: null,
                    recorderStoreUrl: "https://store.example/recorder",
                }}
                exportProviders={{
                    filesystem: false,
                    googleDrive: false,
                    mail: false,
                }}
                initialFolderOrganization={{ folders: [], assignments: [] }}
            />,
        );

        await waitFor(() =>
            expect(screen.getByTestId("onboarding-dialog").textContent).toBe(
                "open:google",
            ),
        );
        expect(window.location.search).toBe("");
    });
});
