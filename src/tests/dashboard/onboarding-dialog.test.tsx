// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingDialog } from "@/components/onboarding-dialog";
import {
    OnboardingStepGoogle,
    OnboardingStepMail,
} from "@/components/onboarding-steps";
import type {
    OnboardingCapabilities,
    OnboardingReadiness,
} from "@/lib/onboarding/capabilities";
import { shouldOpenOnboarding } from "@/lib/onboarding/capabilities";
import type { RecorderExtensionState } from "@/lib/recorder-extension/client";

vi.mock("next-intl", () => {
    const translate = (source: string, values?: Record<string, string>) =>
        Object.entries(values ?? {}).reduce(
            (message, [key, value]) => message.replaceAll(`{${key}}`, value),
            source,
        );
    return { useLocale: () => "en", useExtracted: () => translate };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const { detectRecorder, presence } = vi.hoisted(() => ({
    detectRecorder: vi.fn<() => Promise<RecorderExtensionState>>(async () => ({
        kind: "not-installed",
    })),
    presence: vi.fn((_listener: (state: RecorderExtensionState) => void) =>
        vi.fn(),
    ),
}));
vi.mock("@/lib/recorder-extension/client", () => ({
    browserRecorderExtensionClient: () => ({
        detect: detectRecorder,
        pair: vi.fn(),
        onPresence: presence,
    }),
}));

const capabilities: OnboardingCapabilities = {
    audience: "single-user",
    googleConfigured: false,
    mailAvailable: false,
    mcpConnectorUrl: null,
    recorderStoreUrl: "https://store.example/recorder",
};
const none = { source: "none", name: null, status: "not-connected" } as const;
const snapshot: OnboardingReadiness = {
    plaud: "connected",
    google: "calendar-only",
    ai: { transcription: none, summary: none, mailSummary: null },
    profiles: { audio: { status: "not-connected", name: null }, mail: null },
    mail: { status: "ready", address: "dana@mail.example.com" },
};
const orgReady: OnboardingReadiness = {
    ...snapshot,
    ai: {
        transcription: {
            source: "organization",
            name: "ElevenLabs",
            status: "ready",
        },
        summary: { source: "organization", name: "Codex", status: "ready" },
        mailSummary: null,
    },
    profiles: {
        audio: { status: "ready", name: "Meetings" },
        mail: { status: "ready", name: "Mail" },
    },
};
function wizard(props: Partial<ComponentProps<typeof OnboardingDialog>> = {}) {
    return (
        <OnboardingDialog
            open
            onOpenChange={vi.fn()}
            onComplete={vi.fn()}
            onOpenSettings={vi.fn()}
            capabilities={capabilities}
            {...props}
        />
    );
}
function next() {
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
}

beforeEach(() => {
    detectRecorder.mockReset().mockResolvedValue({ kind: "not-installed" });
    presence.mockReset().mockImplementation(() => vi.fn());
    vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
            if (String(input) === "/api/onboarding/readiness")
                return Response.json(snapshot);
            return Response.json({
                keys: [],
                pending_captures: [],
                defaults: { auto_record_platforms: [] },
                platforms: [],
            });
        }),
    );
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("onboarding audience and effective AI coverage", () => {
    it("keeps the single-user five-step flow", async () => {
        render(wizard());
        expect(screen.getByText("Step 1 of 5")).toBeTruthy();
        next();
        expect(await screen.findByText("Plaud is connected")).toBeTruthy();
        next();
        expect(
            screen.getByRole("heading", { name: "Set up an AI provider" }),
        ).toBeTruthy();
    });
    it("welcomes employees to shared services and optional personal sources", () => {
        render(
            wizard({
                capabilities: {
                    ...capabilities,
                    audience: "organization-member",
                },
            }),
        );
        expect(
            screen.getByText(/Your Organization has set up shared services/),
        ).toBeTruthy();
        next();
        expect(
            screen.getByRole("heading", {
                name: "Connect your own Plaud account",
            }),
        ).toBeTruthy();
        expect(
            screen.getByText(/Add this site in the Connector's popup/),
        ).toBeTruthy();
    });
    it("omits the AI step when both effective roles come from the Organization", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(Response.json(orgReady)),
        );
        render(
            wizard({
                capabilities: {
                    ...capabilities,
                    audience: "organization-member",
                },
            }),
        );
        await screen.findByText("Step 1 of 4");
        next();
        next();
        expect(
            screen.getByRole("heading", { name: "Connect Meeting Recorder" }),
        ).toBeTruthy();
        next();
        expect(
            screen.getByText(
                "AI: provided by your Organization (ElevenLabs, Codex)",
            ),
        ).toBeTruthy();
    });
    it.each([
        "transcription",
        "summary",
    ] as const)("keeps an AI step naming the missing %s role", async (role) => {
        const partial = { ...orgReady, ai: { ...orgReady.ai, [role]: none } };
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(Response.json(partial)),
        );
        render(
            wizard({
                capabilities: {
                    ...capabilities,
                    audience: "organization-member",
                },
                initialStep: "ai-provider",
            }),
        );
        expect(
            await screen.findByText(
                role === "transcription"
                    ? "Still needed: transcription."
                    : "Still needed: summaries.",
            ),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Open provider settings" }),
        ).toBeTruthy();
    });
    it("does not skip personal or managed coverage for a member", async () => {
        const own = {
            ...orgReady,
            ai: {
                ...orgReady.ai,
                summary: { ...orgReady.ai.summary, source: "own" },
            },
        };
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(own)));
        render(
            wizard({
                capabilities: {
                    ...capabilities,
                    audience: "organization-member",
                },
                initialStep: "ai-provider",
            }),
        );
        expect(
            await screen.findByText("Summaries: Ready (Codex)"),
        ).toBeTruthy();
        expect(screen.getByText("Step 3 of 5")).toBeTruthy();
    });
    it("shows only Organization provider/default coverage and profiles for the Organization account", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(Response.json(orgReady)),
        );
        render(
            wizard({
                capabilities: {
                    ...capabilities,
                    audience: "organization-account",
                    googleConfigured: true,
                    mailAvailable: true,
                    mcpConnectorUrl: "https://example.test/api/mcp",
                },
            }),
        );
        expect(screen.getByText("Step 1 of 3")).toBeTruthy();
        next();
        expect(await screen.findByText("Audio profile: Meetings")).toBeTruthy();
        expect(
            screen.getByRole("heading", {
                name: "Organization AI providers and defaults",
            }),
        ).toBeTruthy();
        next();
        expect(screen.getByText("Audio profile: Meetings")).toBeTruthy();
        for (const name of ["Plaud", "Google", "Recorder", "Claude"])
            expect(screen.queryByText(new RegExp(`^${name}:`))).toBeNull();
    });
    it("keeps included Mynah separate from optional personal provider setup", async () => {
        const included = {
            ...snapshot,
            ai: {
                ...snapshot.ai,
                transcription: {
                    source: "managed",
                    name: "Mynah",
                    status: "ready",
                },
            },
        };
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(Response.json(included)),
        );
        render(wizard({ initialStep: "ai-provider" }));
        expect(await screen.findByText("Mynah is ready")).toBeTruthy();
        expect(
            screen.getByText(/Mynah transcription is included with your plan/),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Add your own provider" }),
        ).toBeTruthy();
    });
    it("does not mark unavailable managed transcription ready", async () => {
        const lapsed = {
            ...snapshot,
            ai: {
                ...snapshot.ai,
                transcription: {
                    source: "managed",
                    name: "Mynah",
                    status: "not-connected",
                },
            },
        };
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(Response.json(lapsed)),
        );
        render(wizard({ initialStep: "ai-provider" }));
        await screen.findByText("Still needed: transcription and summaries.");
        expect(screen.queryByText("Mynah is ready")).toBeNull();
    });
});

describe("capability-gated personal steps", () => {
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
            { mcpConnectorUrl: "https://example.test/api/mcp" },
            "Connect Claude",
            "Step 5 of 6",
        ],
        ["recorder", {}, "Connect Meeting Recorder", "Step 4 of 5"],
    ] as const)("shows %s when enabled", async (initialStep, extra, heading, progress) => {
        render(
            wizard({
                capabilities: { ...capabilities, ...extra },
                initialStep,
            }),
        );
        expect(
            await screen.findByRole("heading", { name: heading }),
        ).toBeTruthy();
        expect(screen.getByText(progress)).toBeTruthy();
    });
    it.each([
        "google",
        "mail",
        "claude",
    ] as const)("hides unavailable %s", (initialStep) => {
        render(wizard({ initialStep }));
        expect(
            screen.getByRole("heading", {
                name: "Set up Chatterbox",
                level: 3,
            }),
        ).toBeTruthy();
        expect(screen.getByText("Step 1 of 5")).toBeTruthy();
    });
});

describe("status hydration and explicit decisions", () => {
    it("aborts superseded requests and ignores a late reply", async () => {
        const requests: {
            signal: AbortSignal;
            resolve: (response: Response) => void;
        }[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(
                (_input: RequestInfo | URL, options: RequestInit) =>
                    new Promise<Response>((resolve) => {
                        requests.push({
                            signal: options.signal as AbortSignal,
                            resolve,
                        });
                    }),
            ),
        );
        const { unmount } = render(wizard({ initialStep: "complete" }));
        fireEvent.focus(window);
        expect(requests).toHaveLength(2);
        expect(requests[0].signal.aborted).toBe(true);
        await act(async () => {
            requests[1].resolve(Response.json(orgReady));
        });
        expect(
            screen.getByText(
                "AI: provided by your Organization (ElevenLabs, Codex)",
            ),
        ).toBeTruthy();
        await act(async () => {
            requests[0].resolve(Response.json(snapshot));
        });
        expect(
            screen.getByText(
                "AI: provided by your Organization (ElevenLabs, Codex)",
            ),
        ).toBeTruthy();
        fireEvent.focus(window);
        expect(requests[1].signal.aborted).toBe(true);
        unmount();
        expect(requests[2].signal.aborted).toBe(true);
    });
    it.each([
        false,
        true,
    ])("preserves the good snapshot and hidden AI step after a failed refetch (server seed: %s)", async (seeded) => {
        const fetchReadiness = vi
            .fn()
            .mockResolvedValue(Response.json(orgReady));
        if (seeded) fetchReadiness.mockRejectedValue(new Error("offline"));
        vi.stubGlobal("fetch", fetchReadiness);
        render(
            wizard({
                capabilities: {
                    ...capabilities,
                    audience: "organization-member",
                },
                initialReadiness: seeded ? orgReady : undefined,
                initialStep: "complete",
            }),
        );
        await screen.findByText(
            "AI: provided by your Organization (ElevenLabs, Codex)",
        );
        fetchReadiness.mockRejectedValue(new Error("offline"));
        await act(async () => {
            fireEvent.focus(window);
        });
        expect(
            screen.getByText(
                "AI: provided by your Organization (ElevenLabs, Codex)",
            ),
        ).toBeTruthy();
        expect(screen.getByText("Plaud: Connected")).toBeTruthy();
        expect(screen.getByText("Step 4 of 4")).toBeTruthy();
        expect(screen.queryByText(/Could not check/)).toBeNull();
    });
    it("polls recorder presence only on the recorder and Complete steps with one subscription", async () => {
        render(wizard());
        expect(detectRecorder).not.toHaveBeenCalled();
        next();
        await screen.findByText("Plaud is connected");
        next();
        expect(detectRecorder).not.toHaveBeenCalled();
        next();
        await waitFor(() => expect(detectRecorder).toHaveBeenCalledTimes(1));
        expect(presence).toHaveBeenCalledTimes(1);
        const stopRecorder = presence.mock.results[0].value;
        next();
        await waitFor(() => expect(detectRecorder).toHaveBeenCalledTimes(2));
        expect(presence).toHaveBeenCalledTimes(2);
        expect(stopRecorder).toHaveBeenCalledOnce();
    });
    it("updates Recorder and Complete when the extension appears without overlapping pollers", async () => {
        vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
            "Mozilla/5.0 Chrome/130.0.0.0",
        );
        vi.useFakeTimers();
        const intervals = vi.spyOn(window, "setInterval");
        const clearInterval = vi.spyOn(window, "clearInterval");
        const paired: RecorderExtensionState = {
            kind: "reachable",
            channel: "content",
            paired: true,
            pairedTo: window.location.origin,
            pairedHere: true,
        };
        const { unmount } = render(wizard({ initialStep: "recorder" }));
        await act(async () => {});
        expect(detectRecorder).toHaveBeenCalledTimes(1);
        expect(presence).toHaveBeenCalledTimes(1);
        expect(intervals).toHaveBeenCalledTimes(1);
        expect(intervals.mock.calls[0][1]).toBe(2000);
        detectRecorder.mockResolvedValue(paired);
        await act(async () => vi.advanceTimersByTimeAsync(2000));
        expect(
            screen.getByText(`Connected to ${window.location.host}`).className,
        ).toContain("led-active");
        expect(detectRecorder).toHaveBeenCalledTimes(2);
        act(() => presence.mock.calls[0][0]({ kind: "not-installed" }));
        expect(
            screen.queryByText(`Connected to ${window.location.host}`),
        ).toBeNull();
        const stopRecorder = presence.mock.results[0].value;
        detectRecorder.mockResolvedValue({ kind: "not-installed" });
        next();
        await act(async () => {});
        expect(screen.getByText(/^Recorder: Not set up/)).toBeTruthy();
        expect(detectRecorder).toHaveBeenCalledTimes(3);
        expect(presence).toHaveBeenCalledTimes(2);
        expect(stopRecorder).toHaveBeenCalledOnce();
        expect(stopRecorder.mock.invocationCallOrder[0]).toBeLessThan(
            presence.mock.invocationCallOrder[1],
        );
        expect(intervals).toHaveBeenCalledTimes(2);
        expect(clearInterval).toHaveBeenCalledWith(
            intervals.mock.results[0].value,
        );
        expect(clearInterval.mock.invocationCallOrder[0]).toBeLessThan(
            intervals.mock.invocationCallOrder[1],
        );
        detectRecorder.mockResolvedValue(paired);
        await act(async () => vi.advanceTimersByTimeAsync(2000));
        expect(
            screen.getByText("Recorder: Paired with this site"),
        ).toBeTruthy();
        expect(detectRecorder).toHaveBeenCalledTimes(4);
        act(() => presence.mock.calls[1][0]({ kind: "not-installed" }));
        expect(screen.getByText(/^Recorder: Not set up/)).toBeTruthy();
        const stopComplete = presence.mock.results[1].value;
        unmount();
        expect(stopComplete).toHaveBeenCalledOnce();
        expect(clearInterval).toHaveBeenCalledWith(
            intervals.mock.results[1].value,
        );
        await act(async () => vi.advanceTimersByTimeAsync(4000));
        expect(detectRecorder).toHaveBeenCalledTimes(4);
    });
    it("hydrates all server results on OAuth return without visiting earlier steps", async () => {
        render(
            wizard({
                capabilities: {
                    ...capabilities,
                    googleConfigured: true,
                    mailAvailable: true,
                },
                initialStep: "google",
            }),
        );
        next();
        next();
        next();
        expect(await screen.findByText("Plaud: Connected")).toBeTruthy();
        expect(screen.getByText(/Google: Calendar only/)).toBeTruthy();
        expect(screen.getByText("Mail: Ready")).toBeTruthy();
        expect(screen.queryByText(/Skipped/)).toBeNull();
    });
    it("shows checking while unresolved and could not check after a failed check", async () => {
        let reject: (error: Error) => void = () => {};
        vi.stubGlobal(
            "fetch",
            vi.fn().mockReturnValue(
                new Promise((_resolve, rejectPromise) => {
                    reject = rejectPromise;
                }),
            ),
        );
        render(wizard({ initialStep: "complete" }));
        expect(screen.getByText(/Plaud: Checking/)).toBeTruthy();
        reject(new Error("offline"));
        expect(await screen.findByText(/Plaud: Could not check/)).toBeTruthy();
        expect(screen.queryByText(/Skipped/)).toBeNull();
    });
    it("records Skip only when Skip was pressed and clears it on Next", async () => {
        render(wizard({ initialStep: "plaud" }));
        await screen.findByText("Plaud is connected");
        fireEvent.click(screen.getByRole("button", { name: "Skip" }));
        next();
        next();
        expect(screen.getByText(/Plaud: Skipped/)).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Previous" }));
        fireEvent.click(screen.getByRole("button", { name: "Previous" }));
        fireEvent.click(screen.getByRole("button", { name: "Previous" }));
        next();
        next();
        next();
        expect(screen.getByText("Plaud: Connected")).toBeTruthy();
    });
    it("honors Plaud needsReconnect on the step and in the hydrated summary", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValue(
                    Response.json({ ...snapshot, plaud: "needs-reconnect" }),
                ),
        );
        render(wizard({ initialStep: "plaud" }));
        expect(
            await screen.findByText("Plaud needs reconnecting"),
        ).toBeTruthy();
        expect(screen.queryByText("Plaud is connected")).toBeNull();
        next();
        next();
        next();
        expect(screen.getByText(/Plaud: Reconnect needed/)).toBeTruthy();
    });
    it("acknowledges Claude as user-confirmed, without asserting a verified connection", () => {
        render(
            wizard({
                capabilities: {
                    ...capabilities,
                    mcpConnectorUrl: "https://example.test/api/mcp",
                },
                initialStep: "claude",
            }),
        );
        expect(screen.getByText(/Find Chatterbox, marked Custom/)).toBeTruthy();
        expect(
            screen.getByText("Not in your list?").closest("details")?.open,
        ).toBe(false);
        fireEvent.click(screen.getByRole("button", { name: "Already set up" }));
        next();
        expect(screen.getByText("Claude: Set up (you confirmed)")).toBeTruthy();
        expect(screen.queryByText("Claude: Connected")).toBeNull();
    });
    it("hands off to the selected settings section and resumes without resetting progress", async () => {
        const openSettings = vi.fn();
        const props = {
            initialStep: "ai-provider" as const,
            onOpenSettings: openSettings,
        };
        const { rerender } = render(wizard(props));
        fireEvent.click(
            screen.getByRole("button", { name: "Open provider settings" }),
        );
        expect(openSettings).toHaveBeenCalledWith("providers");
        rerender(wizard({ ...props, suspended: true }));
        expect(screen.queryByRole("dialog")).toBeNull();
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                Response.json({
                    ...snapshot,
                    ai: {
                        ...snapshot.ai,
                        transcription: {
                            source: "own",
                            name: "OpenAI",
                            status: "ready",
                        },
                    },
                }),
            ),
        );
        rerender(wizard(props));
        expect(
            await screen.findByText("Transcription: Ready (OpenAI)"),
        ).toBeTruthy();
        expect(
            screen.getByRole("heading", { name: "Set up an AI provider" }),
        ).toBeTruthy();
    });
    it("passes mail settings through the same handoff", async () => {
        const onOpenSettings = vi.fn();
        render(
            wizard({
                capabilities: { ...capabilities, mailAvailable: true },
                initialStep: "mail",
                onOpenSettings,
            }),
        );
        fireEvent.click(
            await screen.findByRole("button", { name: "Open mail settings" }),
        );
        expect(onOpenSettings).toHaveBeenCalledWith("mail");
    });
    it("remains dismissible after completion and respects the completion setting", () => {
        expect(shouldOpenOnboarding(true)).toBe(false);
        expect(shouldOpenOnboarding(false)).toBe(true);
        const onOpenChange = vi.fn();
        render(wizard({ onOpenChange }));
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });
});

describe("Google status", () => {
    it.each([
        ["connected", "Calendar and Meet are connected"],
        ["calendar-only", "Calendar is connected"],
        ["needs-reconnect", "Google needs reconnecting"],
    ] as const)("shows %s honestly", (status, text) => {
        render(<OnboardingStepGoogle status={status} />);
        expect(screen.getByText(text)).toBeTruthy();
        if (status !== "needs-reconnect")
            expect(screen.getByText(text).className).toContain("led-active");
        if (status === "needs-reconnect")
            expect(screen.queryByText("Calendar is connected")).toBeNull();
    });
});

describe("mail introduction", () => {
    it.each([
        "ready",
        "paused",
        "ineligible",
        "error",
    ] as const)("shows %s honestly", (status) => {
        render(
            <OnboardingStepMail
                onOpenSettings={vi.fn()}
                mail={{ status, address: "dana@mail.example.com" }}
            />,
        );
        expect(screen.getByText("dana@mail.example.com")).toBeTruthy();
        expect(screen.getByText(/Folder addresses are generated/)).toBeTruthy();
        expect(
            screen.getByText(/Send or forward from your company/),
        ).toBeTruthy();
        if (status === "paused")
            expect(screen.getByText(/Mail receiving is paused/)).toBeTruthy();
        if (status === "ineligible")
            expect(screen.getByText(/Mail is available only/)).toBeTruthy();
        if (status === "error")
            expect(screen.getByText("Could not check")).toBeTruthy();
    });
});
