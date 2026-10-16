// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingStepRecorder } from "@/components/onboarding-steps";
import { RecorderSection } from "@/components/settings/recorder-section";
import {
    browserRecorderExtensionClient,
    type RecorderExtensionState,
} from "@/lib/recorder-extension/client";
import {
    DEFAULT_RECORDER_EXTENSION_ID,
    RECORDER_EXTENSION_STORE_URL,
} from "@/lib/recorder-extension/extension-id";

vi.mock("next-intl", () => {
    const translate = (source: string, values?: Record<string, string>) => {
        if (!values) return source;
        return Object.entries(values).reduce(
            (message, [key, value]) => message.replace(`{${key}}`, value),
            source,
        );
    };
    return {
        useExtracted: () => translate,
        useLocale: () => "en",
    };
});
vi.mock("@/lib/recorder-extension/client", () => ({
    browserRecorderExtensionClient: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const detect = vi.fn<() => Promise<RecorderExtensionState>>();
const pair = vi.fn().mockResolvedValue({ ok: true, pending: false });
let userAgent = "";
const status = {
    keys: [],
    pending_captures: [],
    server_url: "https://chatterbox.example.com",
    extension_id: DEFAULT_RECORDER_EXTENSION_ID,
    defaults: {
        auto_record_platforms: [],
        auto_stop_quiet_seconds: 240,
        notice_text: "",
        lock_defaults: false,
    },
    platforms: [],
};

function view(mode: "settings" | "onboarding"): ReactElement {
    if (mode === "settings") return <RecorderSection />;
    return <OnboardingStepRecorder storeUrl={RECORDER_EXTENSION_STORE_URL} />;
}

beforeEach(() => {
    userAgent = "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36";
    detect.mockReset().mockResolvedValue({ kind: "not-installed" });
    pair.mockClear();
    vi.mocked(browserRecorderExtensionClient).mockReturnValue({
        detect,
        pair,
        onPresence: vi.fn(() => vi.fn()),
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === "POST") {
                return Response.json({
                    key_id: "key-1",
                    api_key: "op_recorder",
                    server_url: status.server_url,
                });
            }
            return Response.json(status);
        }),
    );
    vi.spyOn(navigator, "userAgent", "get").mockImplementation(() => userAgent);
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe.each([
    "settings",
    "onboarding",
] as const)("Meeting Recorder %s flow", (mode) => {
    it("starts with the store installation", async () => {
        render(view(mode));
        const link = await screen.findByRole("link", {
            name: "Install from Chrome Web Store",
        });
        expect(link.getAttribute("href")).toBe(RECORDER_EXTENSION_STORE_URL);
        expect(link.getAttribute("target")).toBe("_blank");
        expect(detect).toHaveBeenCalledWith(DEFAULT_RECORDER_EXTENSION_ID);
    });

    it("offers one Connect action when the extension appears", async () => {
        detect.mockResolvedValue({
            kind: "reachable",
            channel: "external",
            paired: false,
        });
        render(view(mode));
        const connect = await screen.findByRole("button", {
            name: "Connect",
        });
        fireEvent.click(connect);
        await waitFor(() =>
            expect(pair).toHaveBeenCalledWith(
                DEFAULT_RECORDER_EXTENSION_ID,
                "external",
                {
                    serverUrl: status.server_url,
                    apiKey: "op_recorder",
                },
            ),
        );
    });

    it("shows the connected instance", async () => {
        detect.mockResolvedValue({
            kind: "reachable",
            channel: "external",
            paired: true,
            pairedHere: true,
            pairedTo: status.server_url,
        });
        render(view(mode));
        expect(
            await screen.findByText("Connected to chatterbox.example.com"),
        ).toBeTruthy();
        if (mode === "settings") {
            expect(screen.getByRole("button", { name: "Rebind" })).toBeTruthy();
        } else {
            expect(screen.queryByRole("button", { name: "Rebind" })).toBeNull();
        }
    });

    it("keeps manual connection collapsed as a fallback", async () => {
        render(view(mode));
        const disclosure = await screen.findByText("Connect manually");
        const details = disclosure.closest("details");
        expect(details?.hasAttribute("open")).toBe(false);
        fireEvent.click(disclosure);
        expect(
            screen.getByRole("button", { name: "Generate recorder key" }),
        ).toBeTruthy();
    });
});

describe("Meeting Recorder browser support", () => {
    it("shows only desktop setup guidance in onboarding on a phone", async () => {
        userAgent =
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1";
        render(view("onboarding"));

        expect(
            await screen.findByText(
                "Meeting Recorder works in desktop Chrome, Edge or Brave. Set it up from your computer with Run setup again in the menu.",
            ),
        ).toBeTruthy();
        expect(
            screen.queryByRole("link", {
                name: "Install from Chrome Web Store",
            }),
        ).toBeNull();
        expect(screen.queryByText("Connect manually")).toBeNull();
    });

    it("keeps the install flow in Settings on a phone", async () => {
        userAgent =
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1";
        render(view("settings"));

        expect(
            await screen.findByRole("link", {
                name: "Install from Chrome Web Store",
            }),
        ).toBeTruthy();
        expect(
            screen.getByText(
                "Open this page in a supported desktop browser to connect.",
            ),
        ).toBeTruthy();
    });
});
