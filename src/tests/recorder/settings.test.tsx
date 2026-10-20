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
interface RecorderStatusFixture {
    keys: {
        id: string;
        name: string;
        key_prefix: string;
        created_at: string;
        last_used_at: string | null;
    }[];
    pending_captures: {
        client_recording_id: string;
        api_key_id: string;
        created_at: string;
        expires_at: string;
    }[];
    server_url: string;
    extension_id: string;
    encrypted_recording_protocol: number;
    defaults: {
        auto_record_platforms: string[];
        auto_stop_quiet_seconds: number;
        notice_text: string;
        notice_text_is_default: boolean;
        lock_defaults: boolean;
    };
    platforms: { id: string; name: string }[];
}

const CHROME =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const browserCases = [
    ["Chrome", CHROME, true],
    ["Edge", `${CHROME} Edg/140.0.0.0`, true],
    ["Opera", `${CHROME} OPR/120.0.0.0`, true],
    ["Chromium", CHROME.replace("Chrome/", "Chromium/"), true],
    [
        "Firefox",
        "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
        false,
    ],
    [
        "Safari",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
        false,
    ],
    [
        "Android Chrome",
        CHROME.replace("X11; Linux x86_64", "Linux; Android 15"),
        false,
    ],
    [
        "iPhone",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/140.0.0.0 Mobile/15E148 Safari/604.1",
        false,
    ],
] as const;
const status: RecorderStatusFixture = {
    keys: [],
    pending_captures: [],
    server_url: "https://chatterbox.example.com",
    extension_id: DEFAULT_RECORDER_EXTENSION_ID,
    encrypted_recording_protocol: 1,
    defaults: {
        auto_record_platforms: [],
        auto_stop_quiet_seconds: 240,
        notice_text: "",
        notice_text_is_default: true,
        lock_defaults: false,
    },
    platforms: [],
};

function stubRecorderStatus(nextStatus: RecorderStatusFixture) {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
        const path = String(input);
        if (path === "/api/settings/recorder/pair") {
            return Response.json(
                {
                    key_id: "key-1",
                    api_key: "op_recorder",
                    extension_id: nextStatus.extension_id,
                    server_url: nextStatus.server_url,
                    encrypted_recording_protocol:
                        nextStatus.encrypted_recording_protocol,
                    defaults: nextStatus.defaults,
                    platforms: nextStatus.platforms,
                },
                { status: 201 },
            );
        }
        if (
            init?.method === "DELETE" ||
            path === "/api/settings/recorder/rebind"
        ) {
            return new Response(null, { status: 204 });
        }
        return Response.json(nextStatus);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

function view(mode: "settings" | "onboarding"): ReactElement {
    if (mode === "settings") return <RecorderSection />;
    return <OnboardingStepRecorder storeUrl={RECORDER_EXTENSION_STORE_URL} />;
}

beforeEach(() => {
    userAgent = CHROME;
    detect.mockReset().mockResolvedValue({ kind: "not-installed" });
    pair.mockClear();
    vi.mocked(browserRecorderExtensionClient).mockReturnValue({
        detect,
        pair,
        onPresence: vi.fn(() => vi.fn()),
    });
    stubRecorderStatus(status);
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

    it("reloads status after generating a manual recorder key", async () => {
        const nextStatus = {
            ...status,
            keys: [
                {
                    id: "key-desk",
                    name: "Desk recorder",
                    key_prefix: "op_rec_desk",
                    created_at: "2026-10-01T10:00:00.000Z",
                    last_used_at: "2026-10-15T10:00:00.000Z",
                },
            ],
            pending_captures: [
                {
                    client_recording_id: "capture-1",
                    api_key_id: "key-desk",
                    created_at: "2026-10-16T10:00:00.000Z",
                    expires_at: "2026-10-17T10:00:00.000Z",
                },
            ],
        };
        const fetchMock = stubRecorderStatus(nextStatus);
        render(view(mode));
        fireEvent.click(await screen.findByText("Connect manually"));
        fireEvent.click(
            screen.getByRole("button", { name: "Generate recorder key" }),
        );

        expect(await screen.findByText("op_recorder")).toBeTruthy();
        await waitFor(() => {
            const statusRequests = fetchMock.mock.calls.filter(
                ([input]) => String(input) === "/api/settings/recorder/status",
            );
            expect(statusRequests).toHaveLength(2);
        });

        if (mode === "settings") {
            fireEvent.click(screen.getByText("Connected recorders"));
            expect(screen.getByText("Desk recorder")).toBeTruthy();
            fireEvent.click(screen.getByText("Recover unfinished recordings"));
            expect(
                screen.getByRole("combobox", { name: "New recorder key" }),
            ).toBeTruthy();
        }
    });
});

describe.each([
    "settings",
    "onboarding",
] as const)("Meeting Recorder browser support in %s", (mode) => {
    it.each(
        browserCases,
    )("handles %s compatibility", async (_browser, browserUserAgent, compatible) => {
        userAgent = browserUserAgent;
        render(view(mode));

        if (mode === "settings") {
            expect(
                await screen.findByRole("link", {
                    name: "Install from Chrome Web Store",
                }),
            ).toBeTruthy();
            if (compatible) {
                expect(
                    screen.queryByText(
                        "Open this page in a supported desktop browser to connect.",
                    ),
                ).toBeNull();
            } else {
                expect(
                    screen.getByText(
                        "Open this page in a supported desktop browser to connect.",
                    ),
                ).toBeTruthy();
            }
            return;
        }

        if (compatible) {
            expect(
                await screen.findByRole("link", {
                    name: "Install from Chrome Web Store",
                }),
            ).toBeTruthy();
            expect(
                screen.queryByText(
                    "Meeting Recorder works in desktop Chrome, Edge or Brave. Set it up from your computer with Re-run setup in the menu.",
                ),
            ).toBeNull();
            return;
        }

        expect(
            await screen.findByText(
                "Meeting Recorder works in desktop Chrome, Edge or Brave. Set it up from your computer with Re-run setup in the menu.",
            ),
        ).toBeTruthy();
        expect(
            screen.queryByRole("link", {
                name: "Install from Chrome Web Store",
            }),
        ).toBeNull();
        expect(screen.queryByText("Connect manually")).toBeNull();
    });
});

describe("Meeting Recorder Settings details", () => {
    const keys = [
        {
            id: "key-desk",
            name: "Desk recorder",
            key_prefix: "op_rec_desk",
            created_at: "2026-10-01T10:00:00.000Z",
            last_used_at: "2026-10-15T10:00:00.000Z",
        },
        {
            id: "key-travel",
            name: "Travel recorder",
            key_prefix: "op_rec_travel",
            created_at: "2026-10-02T10:00:00.000Z",
            last_used_at: null,
        },
    ];
    const pendingCapture = {
        client_recording_id: "capture-1",
        api_key_id: "key-desk",
        created_at: "2026-10-16T10:00:00.000Z",
        expires_at: "2026-10-17T10:00:00.000Z",
    };

    it("shows recorder names, key prefixes, and the write-only note", async () => {
        stubRecorderStatus({ ...status, keys });
        render(view("settings"));
        fireEvent.click(await screen.findByText("Connected recorders"));

        expect(screen.getByText("Desk recorder")).toBeTruthy();
        expect(screen.getByText("op_rec_desk")).toBeTruthy();
        expect(screen.getByText("Travel recorder")).toBeTruthy();
        expect(screen.getByText("op_rec_travel")).toBeTruthy();
        expect(
            screen.getByText(
                "Each key is write-only: it can create recordings but cannot read your library.",
            ),
        ).toBeTruthy();
    });

    it("revokes a recorder immediately when it has no pending captures", async () => {
        const fetchMock = stubRecorderStatus({ ...status, keys });
        render(view("settings"));
        fireEvent.click(await screen.findByText("Connected recorders"));
        fireEvent.click(
            screen.getByRole("button", { name: "Disconnect Desk recorder" }),
        );

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/settings/api-keys/key-desk",
                { method: "DELETE" },
            ),
        );
    });

    it("confirms before revoking a recorder with a pending capture", async () => {
        const fetchMock = stubRecorderStatus({
            ...status,
            keys,
            pending_captures: [pendingCapture],
        });
        render(view("settings"));
        fireEvent.click(await screen.findByText("Connected recorders"));
        const disconnect = screen.getByRole("button", {
            name: "Disconnect Desk recorder",
        });
        fireEvent.click(disconnect);

        expect(
            screen.getByRole("button", { name: "Disconnect anyway" }),
        ).toBeTruthy();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
        expect(
            fetchMock.mock.calls.some(
                ([input, init]) =>
                    String(input) === "/api/settings/api-keys/key-desk" &&
                    init?.method === "DELETE",
            ),
        ).toBe(false);

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(
            screen.queryByRole("button", { name: "Disconnect anyway" }),
        ).toBeNull();
        fireEvent.click(disconnect);
        fireEvent.click(
            screen.getByRole("button", { name: "Disconnect anyway" }),
        );
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/settings/api-keys/key-desk",
                { method: "DELETE" },
            ),
        );
    });

    it("rebinds an unfinished recording to the selected recorder key", async () => {
        const fetchMock = stubRecorderStatus({
            ...status,
            keys,
            pending_captures: [pendingCapture],
        });
        render(view("settings"));
        fireEvent.click(
            await screen.findByText("Recover unfinished recordings"),
        );
        fireEvent.change(
            screen.getByRole("combobox", { name: "New recorder key" }),
            { target: { value: "key-travel" } },
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Authorize recovery" }),
        );

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/settings/recorder/rebind",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        clientRecordingId: "capture-1",
                        apiKeyId: "key-travel",
                    }),
                },
            ),
        );
    });

    it("summarizes automatic platforms, quiet time, and locked defaults", async () => {
        stubRecorderStatus({
            ...status,
            defaults: {
                auto_record_platforms: ["google-meet", "teams"],
                auto_stop_quiet_seconds: 45,
                notice_text: "",
                notice_text_is_default: true,
                lock_defaults: true,
            },
            platforms: [
                { id: "google-meet", name: "Google Meet" },
                { id: "teams", name: "Microsoft Teams" },
            ],
        });
        render(view("settings"));
        fireEvent.click(await screen.findByText("Automatic recording"));

        expect(
            screen.getByText(
                /Automatic recording is on by default for: Google Meet, Microsoft Teams\./,
            ),
        ).toBeTruthy();
        expect(
            screen.getByText(/Recordings stop after 45 seconds of silence\./),
        ).toBeTruthy();
        expect(
            screen.getByText(/These defaults are locked by the server\./),
        ).toBeTruthy();
    });

    it("states when no platform records automatically", async () => {
        stubRecorderStatus(status);
        render(view("settings"));
        fireEvent.click(await screen.findByText("Automatic recording"));

        expect(
            screen.getByText(/No platform records automatically by default\./),
        ).toBeTruthy();
    });

    it("omits every Settings-only detail during onboarding", async () => {
        stubRecorderStatus({
            ...status,
            keys,
            pending_captures: [pendingCapture],
            defaults: {
                ...status.defaults,
                auto_record_platforms: ["google-meet"],
                lock_defaults: true,
            },
            platforms: [{ id: "google-meet", name: "Google Meet" }],
        });
        render(view("onboarding"));
        await screen.findByRole("link", {
            name: "Install from Chrome Web Store",
        });

        expect(screen.queryByText("Connected recorders")).toBeNull();
        expect(screen.queryByText("Automatic recording")).toBeNull();
        expect(screen.queryByText("Recover unfinished recordings")).toBeNull();
        expect(
            screen.queryByText(
                "Each key is write-only: it can create recordings but cannot read your library.",
            ),
        ).toBeNull();
    });
});

describe.each([
    "settings",
    "onboarding",
] as const)("recorder detected states in %s", (mode) => {
    it("never offers Install for an installed-unreachable extension", async () => {
        detect.mockResolvedValue({ kind: "installed-unreachable" });
        render(view(mode));
        expect(
            await screen.findByText(
                "Extension found. Open its toolbar icon and allow access to this site.",
            ),
        ).toBeTruthy();
        expect(
            screen.queryByRole("link", {
                name: "Install from Chrome Web Store",
            }),
        ).toBeNull();
    });
    it("keeps pending confirmation visible until a paired ping arrives", async () => {
        detect.mockResolvedValue({
            kind: "reachable",
            channel: "content",
            paired: false,
        });
        pair.mockResolvedValueOnce({ ok: true, pending: true });
        render(view(mode));
        fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
        expect(
            await screen.findByText("Confirm this server in the extension"),
        ).toBeTruthy();
        expect(screen.queryByText(/Connected to/)).toBeNull();
        await waitFor(() =>
            expect(
                screen
                    .getByRole("button", { name: "Connect" })
                    .hasAttribute("disabled"),
            ).toBe(false),
        );
        detect.mockResolvedValue({
            kind: "reachable",
            channel: "content",
            paired: true,
            pairedHere: true,
            pairedTo: status.server_url,
        });
        fireEvent.focus(window);
        expect(
            await screen.findByText("Connected to chatterbox.example.com"),
        ).toBeTruthy();
        await waitFor(() =>
            expect(
                screen.queryByText("Confirm this server in the extension"),
            ).toBeNull(),
        );
    });
    it("offers to connect here when paired elsewhere", async () => {
        detect.mockResolvedValue({
            kind: "reachable",
            channel: "content",
            paired: true,
            pairedHere: false,
            pairedTo: "https://other.example",
        });
        render(view(mode));
        expect(
            await screen.findByText("Connected to other.example"),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Connect to this instance" }),
        ).toBeTruthy();
    });
    it.each([
        "prompt",
        "denied",
        "unknown",
        "granted",
        undefined,
    ] as const)("handles microphone permission %s", async (micPermission) => {
        detect.mockResolvedValue({
            kind: "reachable",
            channel: "content",
            paired: false,
            micPermission,
        });
        render(view(mode));
        await screen.findByRole("button", { name: "Connect" });
        expect(
            Boolean(
                screen.queryByText(
                    "Allow the microphone in the extension, or your voice will not be recorded",
                ),
            ),
        ).toBe(micPermission !== undefined && micPermission !== "granted");
    });
});
