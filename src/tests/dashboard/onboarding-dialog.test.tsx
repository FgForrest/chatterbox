// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    OnboardingDialog,
    type OnboardingStepId,
} from "@/components/onboarding-dialog";
import {
    OnboardingStepComplete,
    OnboardingStepGoogle,
    OnboardingStepMail,
    type OnboardingSummaryItem,
} from "@/components/onboarding-steps";
import { useGoogleConnection } from "@/hooks/use-google-connection";
import type { OnboardingCapabilities } from "@/lib/onboarding/capabilities";
import { shouldOpenOnboarding } from "@/lib/onboarding/capabilities";

vi.mock("next-intl", () => ({
    useLocale: () => "en",
    useExtracted: () => (source: string, values?: Record<string, string>) => {
        if (!values) return source;
        return Object.entries(values).reduce(
            (message, [key, value]) => message.replace(`{${key}}`, value),
            source,
        );
    },
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/use-google-connection", () => ({
    useGoogleConnection: vi.fn(),
}));
vi.mock("@/lib/recorder-extension/client", () => ({
    browserRecorderExtensionClient: () => ({
        detect: vi.fn().mockResolvedValue({ kind: "not-installed" }),
        pair: vi.fn(),
        onPresence: vi.fn(() => vi.fn()),
    }),
}));

const baseCapabilities: OnboardingCapabilities = {
    googleConfigured: false,
    mailAvailable: false,
    mcpConnectorUrl: null,
    recorderStoreUrl: "https://store.example/recorder",
};

beforeEach(() => {
    vi.mocked(useGoogleConnection).mockReturnValue({
        state: null,
        loading: false,
        refresh: vi.fn(),
    });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("onboarding mail loading", () => {
    it("keeps mail settings off the dashboard render path", () => {
        const source = readFileSync(
            join(process.cwd(), "src/app/(app)/dashboard/page.tsx"),
            "utf8",
        );
        expect(source).not.toContain("loadMailSettings");
        expect(source).toContain("mailAvailable");
    });

    it("loads and shows the address when the mail step opens", async () => {
        const onReady = vi.fn();
        const fetchMock = vi.fn().mockResolvedValue(
            Response.json({
                domain: "mail.example.com",
                eligible: true,
                receiving: true,
                addresses: [
                    {
                        id: "mailbox-1",
                        kind: "mailbox",
                        address: "dana@mail.example.com",
                        label: null,
                        primary: true,
                        folderId: null,
                        baseAddressId: null,
                        lastReceivedAt: null,
                        createdAt: "2026-10-16T12:00:00.000Z",
                    },
                ],
            }),
        );
        vi.stubGlobal("fetch", fetchMock);

        render(
            <OnboardingStepMail onOpenSettings={vi.fn()} onReady={onReady} />,
        );

        expect(screen.getByText("Loading your mail address…")).toBeTruthy();
        expect(await screen.findByText("dana@mail.example.com")).toBeTruthy();
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/addresses");
        expect(onReady).toHaveBeenCalledWith(true);
    });
});

describe("Google onboarding state", () => {
    it.each([
        [
            "Calendar and Meet",
            {
                available: true,
                connection: {
                    email: "person@example.com",
                    hostedDomain: null,
                    status: "active" as const,
                    calendarGranted: true,
                    meetGranted: true,
                },
            },
            "calendar-meet",
        ],
        [
            "Calendar only",
            {
                available: true,
                connection: {
                    email: "person@example.com",
                    hostedDomain: null,
                    status: "active" as const,
                    calendarGranted: true,
                    meetGranted: false,
                },
            },
            "calendar-only",
        ],
        [
            "not connected",
            { available: true, connection: null },
            "not-connected",
        ],
    ] as const)("reports %s from the Google step", async (_label, state, expected) => {
        vi.mocked(useGoogleConnection).mockReturnValue({
            state,
            loading: false,
            refresh: vi.fn(),
        });
        const onConnectionChange = vi.fn();

        render(
            <OnboardingStepGoogle onConnectionChange={onConnectionChange} />,
        );

        await waitFor(() =>
            expect(onConnectionChange).toHaveBeenLastCalledWith(expected),
        );
    });

    it.each([
        ["connected", "Google: Connected", true],
        ["calendar-only", "Google: Calendar only", true],
        ["skipped", "Google: Skipped · Settings → Google Account", false],
    ] as const)("shows the %s state in the finish summary", (status, text, ready) => {
        const item: OnboardingSummaryItem = {
            id: "google",
            label: "Google",
            status,
            location: "Settings → Google Account",
        };

        render(<OnboardingStepComplete items={[item]} />);

        const line = screen.getByText(text).closest("li");
        expect(line?.className.includes("led-active")).toBe(ready);
    });
});

describe("capability-gated onboarding steps", () => {
    it.each([
        [
            "google",
            { googleConfigured: true },
            "Connect Google Calendar and Meet",
            "Step 4 of 6",
        ],
        [
            "mail",
            { mailAvailable: true },
            "Send email to Chatterbox",
            "Step 5 of 6",
        ],
        [
            "claude",
            { mcpConnectorUrl: "https://example.com/mcp" },
            "Connect Claude",
            "Step 5 of 6",
        ],
        ["recorder", {}, "Connect Meeting Recorder", "Step 4 of 5"],
    ] as const)("shows the %s step and renumbers progress when available", async (initialStep, enabled, heading, progress) => {
        if (initialStep === "mail") {
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue(Response.json({ addresses: [] })),
            );
        }
        render(
            <OnboardingDialog
                open
                onOpenChange={vi.fn()}
                onComplete={vi.fn()}
                capabilities={{ ...baseCapabilities, ...enabled }}
                initialStep={initialStep}
            />,
        );

        expect(
            await screen.findByRole("heading", { level: 3, name: heading }),
        ).toBeTruthy();
        expect(screen.getByText(progress)).toBeTruthy();
    });

    it.each([
        ["google", "Connect Google Calendar and Meet"],
        ["mail", "Send email to Chatterbox"],
        ["claude", "Connect Claude"],
    ] as const)("hides the %s step and excludes it from progress when unavailable", (initialStep, heading) => {
        render(
            <OnboardingDialog
                open
                onOpenChange={vi.fn()}
                onComplete={vi.fn()}
                capabilities={baseCapabilities}
                initialStep={initialStep as OnboardingStepId}
            />,
        );

        expect(
            screen.getByRole("heading", {
                level: 3,
                name: "Set up Chatterbox",
            }),
        ).toBeTruthy();
        expect(screen.queryByText(heading)).toBeNull();
        expect(screen.getByText("Step 1 of 5")).toBeTruthy();
    });
});

describe("re-run onboarding", () => {
    it("does not open automatically after completion", () => {
        expect(shouldOpenOnboarding(true)).toBe(false);
        expect(shouldOpenOnboarding(false)).toBe(true);
    });

    it("is dismissible and starts at welcome for a completed user", () => {
        const onOpenChange = vi.fn();
        render(
            <OnboardingDialog
                open
                onOpenChange={onOpenChange}
                onComplete={vi.fn()}
                mandatory={false}
                capabilities={baseCapabilities}
                initialStep="welcome"
            />,
        );
        expect(
            screen.getByRole("heading", {
                level: 3,
                name: "Set up Chatterbox",
            }),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("summarizes connected and skipped steps", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url === "/api/plaud/connection") {
                    return Response.json({ connected: true });
                }
                if (url === "/api/settings/ai/providers") {
                    return Response.json({ providers: [] });
                }
                if (url === "/api/settings/recorder/status") {
                    return Response.json({
                        keys: [],
                        pending_captures: [],
                        server_url: "https://chatterbox.example.com",
                        defaults: {
                            auto_record_platforms: [],
                            auto_stop_quiet_seconds: 240,
                            notice_text: "",
                            lock_defaults: false,
                        },
                        platforms: [],
                    });
                }
                throw new Error(`Unexpected request: ${url}`);
            }),
        );

        render(
            <OnboardingDialog
                open
                onOpenChange={vi.fn()}
                onComplete={vi.fn()}
                capabilities={baseCapabilities}
            />,
        );

        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        expect(await screen.findByText("Plaud is connected")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        expect(
            await screen.findByRole("heading", {
                level: 3,
                name: "Set up an AI provider",
            }),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        expect(
            await screen.findByRole("heading", {
                level: 3,
                name: "Connect Meeting Recorder",
            }),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Next" }));

        const connected = screen.getByText("Plaud: Connected");
        expect(connected.closest("li")?.className).toContain("led-active");
        expect(
            screen.getByText("AI provider: Skipped · Settings → Providers"),
        ).toBeTruthy();
        expect(
            screen.getByText("Recorder: Skipped · Settings → Meeting Recorder"),
        ).toBeTruthy();
    });
});
