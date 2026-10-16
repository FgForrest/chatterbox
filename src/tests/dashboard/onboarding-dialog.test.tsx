// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingDialog } from "@/components/onboarding-dialog";
import { OnboardingStepMail } from "@/components/onboarding-steps";
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
vi.mock("@/lib/recorder-extension/client", () => ({
    browserRecorderExtensionClient: () => ({
        detect: vi.fn().mockResolvedValue({ kind: "not-installed" }),
        pair: vi.fn(),
        onPresence: vi.fn(() => vi.fn()),
    }),
}));

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
                capabilities={{
                    googleConfigured: false,
                    mailAvailable: false,
                    mcpConnectorUrl: null,
                    recorderStoreUrl: "https://store.example/recorder",
                }}
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
                capabilities={{
                    googleConfigured: false,
                    mailAvailable: false,
                    mcpConnectorUrl: null,
                    recorderStoreUrl: "https://store.example/recorder",
                }}
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
