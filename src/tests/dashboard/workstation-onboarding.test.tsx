// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
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
    SettingsDialog: ({
        open,
        onOpenChange,
        headerAction,
    }: {
        open: boolean;
        onOpenChange: (open: boolean) => void;
        headerAction?: ReactNode;
    }) =>
        open ? (
            <div data-testid="settings-dialog">
                {headerAction}
                <button type="button" onClick={() => onOpenChange(false)}>
                    Close settings
                </button>
            </div>
        ) : null,
}));
vi.mock("@/components/onboarding-dialog", () => ({
    OnboardingDialog: ({
        open,
        initialStep,
        suspended,
        onOpenSettings,
    }: {
        open: boolean;
        initialStep: string;
        suspended: boolean;
        onOpenSettings: (section: "providers" | "mail") => void;
    }) => (
        <div data-testid="onboarding-dialog">
            <span>
                {open
                    ? suspended
                        ? `suspended:${initialStep}`
                        : `open:${initialStep}`
                    : `closed:${initialStep}`}
            </span>
            <button type="button" onClick={() => onOpenSettings("providers")}>
                Set up providers
            </button>
            <button type="button" onClick={() => onOpenSettings("mail")}>
                Set up mail
            </button>
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
                    audience: "single-user",
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
            expect(
                screen.getByTestId("onboarding-dialog").querySelector("span")
                    ?.textContent,
            ).toBe("open:google"),
        );
        expect(window.location.search).toBe("");
    });
});

describe("workstation Settings handoff", () => {
    it.each([
        "providers",
        "mail",
    ] as const)("opens %s in-app and resumes setup on close", async (section) => {
        window.history.replaceState({}, "", "/dashboard?onboarding=google");
        render(
            <Workstation
                recordings={[]}
                transcriptions={new Map()}
                initialSettings={{
                    ...INITIAL_SETTINGS_DEFAULTS,
                    onboardingCompleted: false,
                }}
                plaudNeedsReconnect={false}
                isHosted={false}
                mailEnabled
                onboardingCapabilities={{
                    audience: "organization-member",
                    googleConfigured: true,
                    mailAvailable: true,
                    mcpConnectorUrl: null,
                    recorderStoreUrl: "https://store.example",
                }}
                exportProviders={{
                    filesystem: false,
                    googleDrive: false,
                    mail: false,
                }}
                initialFolderOrganization={{ folders: [], assignments: [] }}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", {
                name:
                    section === "providers"
                        ? "Set up providers"
                        : "Set up mail",
            }),
        );
        expect(window.location.hash).toBe(`#${section}`);
        expect(screen.getByTestId("settings-dialog")).toBeTruthy();
        expect(screen.getByText("suspended:google")).toBeTruthy();
        fireEvent.click(
            screen.getByRole("button", { name: "Return to setup" }),
        );
        expect(screen.queryByTestId("settings-dialog")).toBeNull();
        expect(screen.getByText("open:google")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Set up mail" }));
        fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
        expect(screen.getByText("open:google")).toBeTruthy();
    });
});
