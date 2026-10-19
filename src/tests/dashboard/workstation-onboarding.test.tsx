// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppChromeProvider } from "@/components/app-chrome-provider";
import { SettingsPageContent } from "@/components/settings/settings-page-content";
import { useSettingsNav } from "@/hooks/use-settings-nav";
import { INITIAL_SETTINGS_DEFAULTS } from "@/lib/settings/initial-settings";

const mocks = vi.hoisted(() => ({ pathname: "/dashboard", push: vi.fn() }));
vi.mock("next-intl", () => ({
    useExtracted: () => (source: string) => source,
}));
vi.mock("next/navigation", () => ({
    usePathname: () => mocks.pathname,
    useRouter: () => ({ refresh: vi.fn(), push: mocks.push }),
}));
vi.mock("@/components/app-upload-button", () => ({
    AppUploadButton: () => null,
}));
vi.mock("@/components/dashboard/shortcuts-dialog", () => ({
    ShortcutsDialog: () => null,
}));
vi.mock("@/components/dashboard/command-palette", () => ({
    CommandPalette: () => null,
}));
vi.mock("@/components/settings-dialog", () => ({
    SettingsDialog: ({
        open,
        onOpenChange,
        headerAction,
        isOrgAccount,
    }: {
        open: boolean;
        onOpenChange: (open: boolean) => void;
        headerAction?: ReactNode;
        isOrgAccount: boolean;
    }) => {
        const { activeSection } = useSettingsNav(
            open,
            () => onOpenChange(false),
            false,
            true,
            false,
            isOrgAccount,
        );
        return open ? (
            <div
                data-testid="settings-dialog"
                data-org-account={isOrgAccount}
                data-section={activeSection}
            >
                {headerAction}
                <button type="button" onClick={() => onOpenChange(false)}>
                    Close settings
                </button>
            </div>
        ) : null;
    },
}));
vi.mock("@/components/onboarding-dialog", () => ({
    OnboardingDialog: ({
        open,
        initialStep,
        mandatory,
        suspended,
        onOpenSettings,
    }: {
        open: boolean;
        initialStep: string;
        mandatory: boolean;
        suspended: boolean;
        onOpenSettings: (section: "providers" | "mail" | "profiles") => void;
    }) => (
        <div data-testid="onboarding-dialog" data-mandatory={mandatory}>
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
            <button type="button" onClick={() => onOpenSettings("profiles")}>
                Set up profiles
            </button>
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

beforeEach(() => {
    mocks.pathname = "/dashboard";
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ providers: [] }))),
    );
});
afterEach(() => {
    cleanup();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

function renderChrome(onboardingCompleted = true, organization = false) {
    return render(
        <AppChromeProvider
            initialSettings={{
                ...INITIAL_SETTINGS_DEFAULTS,
                onboardingCompleted,
            }}
            isAdmin={false}
            isOrgAccount={organization}
            userEmail="person@example.com"
            isHosted={false}
            mailEnabled={!organization}
            accessManagement={false}
            onboardingCapabilities={{
                audience: organization
                    ? "organization-account"
                    : "organization-member",
                googleConfigured: true,
                mailAvailable: !organization,
                mcpConnectorUrl: null,
                recorderStoreUrl: "https://store.example/recorder",
            }}
        >
            {mocks.pathname === "/settings" ? <SettingsPageContent /> : "App"}
        </AppChromeProvider>,
    );
}

describe.each([
    "/dashboard",
    "/almanac",
    "/tasks",
])("layout onboarding on %s", (pathname) => {
    it("opens the setup wizard on Google from the resume query", async () => {
        mocks.pathname = pathname;
        window.history.replaceState({}, "", `${pathname}?onboarding=google`);
        renderChrome();
        await waitFor(() =>
            expect(screen.getByText("open:google")).toBeTruthy(),
        );
        expect(
            screen
                .getByTestId("onboarding-dialog")
                .getAttribute("data-mandatory"),
        ).toBe("false");
        expect(window.location.search).toBe("");
    });
    it("keeps first-run setup mandatory", () => {
        mocks.pathname = pathname;
        renderChrome(false);
        expect(screen.getByText("open:welcome")).toBeTruthy();
        expect(
            screen
                .getByTestId("onboarding-dialog")
                .getAttribute("data-mandatory"),
        ).toBe("true");
    });
    it.each([
        "providers",
        "mail",
        "profiles",
    ] as const)("opens %s in-app and resumes setup on close", async (section) => {
        mocks.pathname = pathname;
        window.history.replaceState({}, "", `${pathname}?onboarding=google`);
        renderChrome(false);
        fireEvent.click(
            screen.getByRole("button", { name: `Set up ${section}` }),
        );
        await waitFor(() =>
            expect(
                screen
                    .getByTestId("settings-dialog")
                    .getAttribute("data-section"),
            ).toBe(section),
        );
        expect(window.location.hash).toBe(`#${section}`);
        expect(screen.getAllByTestId("settings-dialog")).toHaveLength(1);
        expect(screen.getByText("suspended:google")).toBeTruthy();
        fireEvent.click(
            screen.getByRole("button", { name: "Return to setup" }),
        );
        expect(screen.queryByTestId("settings-dialog")).toBeNull();
        expect(screen.getByText("open:google")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Set up mail" }));
        fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
        expect(screen.getByText("open:google")).toBeTruthy();
        expect(mocks.push).not.toHaveBeenCalled();
    });
    it("passes the Organization Recorder filter to the shared Settings dialog", () => {
        mocks.pathname = pathname;
        renderChrome(true, true);
        fireEvent.keyDown(window, { key: "," });
        expect(
            screen
                .getByTestId("settings-dialog")
                .getAttribute("data-org-account"),
        ).toBe("true");
    });
});

it("applies the Organization filter to the single Settings dialog on /settings", () => {
    mocks.pathname = "/settings";
    renderChrome(true, true);
    expect(screen.getAllByTestId("settings-dialog")).toHaveLength(1);
    expect(
        screen.getByTestId("settings-dialog").getAttribute("data-org-account"),
    ).toBe("true");
});
