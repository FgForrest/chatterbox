// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppChromeProvider } from "@/components/app-chrome-provider";
import { INITIAL_SETTINGS_DEFAULTS } from "@/lib/settings/initial-settings";

vi.mock("next-intl", () => ({
    useExtracted: () => (source: string) => source,
}));
vi.mock("next/navigation", () => ({
    usePathname: () => "/dashboard",
    useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/components/dashboard/shortcuts-dialog", () => ({
    ShortcutsDialog: () => null,
}));
vi.mock("@/components/dashboard/command-palette", () => ({
    CommandPalette: () => null,
}));
vi.mock("@/components/settings-dialog", () => ({ SettingsDialog: () => null }));
vi.mock("@/components/onboarding-dialog", () => ({
    OnboardingDialog: ({
        open,
        initialStep,
        mandatory,
    }: {
        open: boolean;
        initialStep: string;
        mandatory: boolean;
    }) => (
        <div data-testid="onboarding-dialog">
            {open ? `open:${initialStep}:${mandatory}` : "closed"}
        </div>
    ),
}));
vi.mock("@/hooks/use-auto-sync", () => ({
    useAutoSync: () => ({ manualSync: vi.fn() }),
}));
vi.mock("@/hooks/use-google-connection", () => ({
    useGoogleConnectOutcome: vi.fn(),
}));
vi.mock("@/hooks/use-theme", () => ({
    useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
    vi.clearAllMocks();
});

function renderChrome(onboardingCompleted = true) {
    render(
        <AppChromeProvider
            initialSettings={{
                ...INITIAL_SETTINGS_DEFAULTS,
                onboardingCompleted,
            }}
            isAdmin={false}
            userEmail="person@example.com"
            isHosted={false}
            mailEnabled={false}
            accessManagement={false}
            onboardingCapabilities={{
                googleConfigured: true,
                mailAvailable: false,
                mcpConnectorUrl: null,
                recorderStoreUrl: "https://store.example/recorder",
            }}
        >
            App
        </AppChromeProvider>,
    );
}

describe("layout onboarding", () => {
    it("opens the setup wizard on Google from the resume query", async () => {
        window.history.replaceState({}, "", "/dashboard?onboarding=google");
        renderChrome();
        await waitFor(() =>
            expect(screen.getByTestId("onboarding-dialog").textContent).toBe(
                "open:google:false",
            ),
        );
        expect(window.location.search).toBe("");
    });
    it("keeps first-run setup mandatory", () => {
        renderChrome(false);
        expect(screen.getByTestId("onboarding-dialog").textContent).toBe(
            "open:welcome:true",
        );
    });
});
