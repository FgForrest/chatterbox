// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    const translate = (source: string) => source;
    return {
        useExtracted: () => translate,
        useLocale: () => "en",
    };
});
vi.mock("@/lib/recorder-extension/client", () => ({
    browserRecorderExtensionClient: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const CHROME =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const detect = vi.fn<() => Promise<RecorderExtensionState>>();
const pair = vi.fn().mockResolvedValue({ ok: true, pending: true });
const status = {
    keys: [],
    pending_captures: [],
    server_url: "https://chatterbox.example.com",
    extension_id: "pojdfnhpfijfolehkjidbomgjemonkge",
    defaults: {
        auto_record_platforms: [],
        auto_stop_quiet_seconds: 240,
        notice_text: "",
        lock_defaults: false,
    },
    platforms: [],
};

beforeEach(() => {
    detect.mockReset().mockResolvedValue({ kind: "not-installed" });
    pair.mockClear();
    vi.mocked(browserRecorderExtensionClient).mockReturnValue({
        detect,
        pair,
        onPresence: vi.fn(() => vi.fn()),
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(status)),
    );
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(CHROME);
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("Meeting Recorder installation", () => {
    it.each([
        ["Chrome", CHROME],
        ["Edge", `${CHROME} Edg/140.0.0.0`],
        ["Brave", CHROME],
        ["Opera", `${CHROME} OPR/120.0.0.0`],
        ["Chromium", CHROME.replace("Chrome/", "Chromium/")],
    ])("offers the published extension and setup recipe in desktop %s", async (_browser, userAgent) => {
        vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
        render(<RecorderSection />);
        const link = await screen.findByRole("link", {
            name: "Install from Chrome Web Store",
        });
        expect(link.getAttribute("href")).toBe(
            "https://chromewebstore.google.com/detail/chatterbox-meeting-record/pojdfnhpfijfolehkjidbomgjemonkge",
        );
        expect(link.getAttribute("target")).toBe("_blank");
        expect(link.getAttribute("rel")).toContain("noopener");
        expect(
            screen.getByRole("heading", { name: "Quick setup" }),
        ).toBeTruthy();
        expect(screen.getAllByRole("listitem")).toHaveLength(4);
        expect(detect).toHaveBeenCalledWith(DEFAULT_RECORDER_EXTENSION_ID);
    });

    it.each([
        [
            "Firefox",
            "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
        ],
        [
            "Safari",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
        ],
        [
            "Android Chrome",
            CHROME.replace("X11; Linux x86_64", "Linux; Android 15"),
        ],
        [
            "iOS Chrome",
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/140.0.0.0 Mobile/15E148 Safari/604.1",
        ],
    ])("explains browser compatibility without offering installation in %s", async (_browser, userAgent) => {
        vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
        render(<RecorderSection />);
        await screen.findByText(/open this page in desktop Chrome/);
        expect(
            screen.queryByRole("link", { name: /Chrome Web Store/ }),
        ).toBeNull();
        expect(
            screen.queryByRole("heading", { name: "Quick setup" }),
        ).toBeNull();
        expect(screen.getByText("Manual setup")).toBeTruthy();
    });

    it("detects the extension after installation and pairs with the published ID", async () => {
        render(<RecorderSection />);
        await screen.findByRole("link", {
            name: "Install from Chrome Web Store",
        });
        detect.mockResolvedValue({
            kind: "reachable",
            channel: "external",
            paired: false,
        });
        fireEvent(window, new Event("focus"));
        const setup = await screen.findByRole("button", {
            name: "Set up recorder",
        });
        expect(
            screen
                .getByRole("link", { name: "View in Chrome Web Store" })
                .getAttribute("href"),
        ).toBe(RECORDER_EXTENSION_STORE_URL);
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    ...status,
                    key_id: "key-1",
                    api_key: "op_recorder",
                }),
            ),
        );
        fireEvent.click(setup);
        await waitFor(() =>
            expect(pair).toHaveBeenCalledWith(
                "pojdfnhpfijfolehkjidbomgjemonkge",
                "external",
                { serverUrl: status.server_url, apiKey: "op_recorder" },
            ),
        );
        await waitFor(() => expect(setup.hasAttribute("disabled")).toBe(false));
    });
});
