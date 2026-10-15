import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

function setupPopup(tabUrl) {
    const nodes = new Map();
    let onMessage;
    const node = (id) => {
        if (!nodes.has(id)) {
            const listeners = new Map();
            nodes.set(id, {
                hidden: true,
                disabled: false,
                textContent: "",
                style: {},
                attributes: new Map(),
                setAttribute(name, value) {
                    this.attributes.set(name, value);
                },
                addEventListener: (type, listener) =>
                    listeners.set(type, listener),
                click: () => listeners.get("click")?.(),
            });
        }
        return nodes.get(id);
    };
    const sendMessage = vi.fn(async (message) =>
        message.type === "get-state"
            ? { state: { state: "idle" } }
            : { ok: true },
    );
    const close = vi.fn();

    vi.stubGlobal("document", {
        documentElement: { lang: "" },
        title: "",
        getElementById: node,
        querySelectorAll: () => [],
    });
    vi.stubGlobal("window", { close });
    vi.stubGlobal("chrome", {
        i18n: {
            getUILanguage: () => "en",
            getMessage: (key) => key,
        },
        storage: {
            local: {
                get: async () => ({
                    serverUrl: "https://example.com",
                    encryptedApiKey: { ciphertext: "test" },
                    dataUseAcknowledgedAt: "2026-10-13T00:00:00.000Z",
                }),
            },
        },
        tabs: { query: async () => [{ id: 42, url: tabUrl }] },
        runtime: {
            sendMessage,
            onMessage: {
                addListener: (listener) => {
                    onMessage = listener;
                },
            },
        },
    });

    return {
        node,
        sendMessage,
        close,
        dispatchState: (state) => onMessage({ type: "state", state }),
    };
}

describe("manual recorder start", () => {
    it.each([
        [
            "detected meeting",
            "https://meet.google.com/abc-defg-hij",
            "google-meet",
            true,
        ],
        ["other tab", "https://example.com", undefined, false],
    ])("starts from one confirmation click on a %s", async (_, url, platformHint, pickerHidden) => {
        const { node, sendMessage, close } = setupPopup(url);
        await import("../../../extensions/recorder/popup/popup.js");
        await vi.waitFor(() => expect(node("view-idle").hidden).toBe(false));

        expect(node("picker-hint").hidden).toBe(pickerHidden);
        await node("start").click();

        const startCalls = sendMessage.mock.calls.filter(
            ([message]) => message.type === "start-recording",
        );
        expect(startCalls).toHaveLength(1);
        expect(startCalls[0][0].payload).toMatchObject({
            tabId: 42,
            platformHint,
            noticeAcknowledgedAt: expect.any(String),
        });
        expect(
            Number.isNaN(
                Date.parse(startCalls[0][0].payload.noticeAcknowledgedAt),
            ),
        ).toBe(false);
        expect(close).toHaveBeenCalledOnce();
    });

    it("shows progress while Chrome handles the capture request", async () => {
        const { node, sendMessage, close } = setupPopup("https://example.com");
        let finishStart;
        sendMessage.mockImplementation((message) =>
            message.type === "get-state"
                ? Promise.resolve({ state: { state: "idle" } })
                : new Promise((resolve) => {
                      finishStart = resolve;
                  }),
        );
        await import("../../../extensions/recorder/popup/popup.js");
        await vi.waitFor(() => expect(node("view-idle").hidden).toBe(false));

        const start = node("start").click();
        expect(node("start").disabled).toBe(true);
        expect(node("start").textContent).toBe("openingPicker");
        expect(close).not.toHaveBeenCalled();

        finishStart({ ok: true });
        await start;
        expect(close).toHaveBeenCalledOnce();
    });

    it("shows upload progress, waits for server completion, then returns to start", async () => {
        const { node, dispatchState } = setupPopup("https://example.com");
        await import("../../../extensions/recorder/popup/popup.js");
        await vi.waitFor(() => expect(node("view-idle").hidden).toBe(false));

        dispatchState({
            state: "recording",
            stopped: true,
            chunkCount: 4,
            uploaded: [0, 1],
        });
        await vi.waitFor(() =>
            expect(node("view-finalizing").hidden).toBe(false),
        );
        expect(node("finalizing-progress-fill").style.width).toBe("50%");
        expect(node("finalizing-upload").hidden).toBe(false);
        expect(node("finalizing-processing").hidden).toBe(true);
        expect(
            node("finalizing-progress").attributes.get("aria-valuenow"),
        ).toBe("50");
        expect(node("view-completed").hidden).toBe(true);

        dispatchState({
            state: "finalizing",
            stopped: true,
            chunkCount: 4,
            uploaded: [0, 1, 2, 3],
        });
        await vi.waitFor(() =>
            expect(node("finalizing-stage").textContent).toBe(
                "processingRecording",
            ),
        );
        expect(node("finalizing-progress-fill").style.width).toBe("100%");
        expect(node("finalizing-upload").hidden).toBe(true);
        expect(node("finalizing-processing").hidden).toBe(false);
        expect(node("processing-status").textContent).toBe("uploadComplete");
        expect(node("processing-elapsed").textContent).toBe(
            "processingElapsed",
        );
        expect(node("view-completed").hidden).toBe(true);

        dispatchState({ state: "completed", partial: false });
        await vi.waitFor(() =>
            expect(node("view-completed").hidden).toBe(false),
        );
        expect(node("completion-check").hidden).toBe(false);
        expect(node("completion-message").textContent).toBe("recordingStored");

        dispatchState({ state: "idle" });
        await vi.waitFor(() => expect(node("view-idle").hidden).toBe(false));
    });

    it("does not show a success check for a partial recording", async () => {
        const { node, dispatchState } = setupPopup("https://example.com");
        await import("../../../extensions/recorder/popup/popup.js");
        await vi.waitFor(() => expect(node("view-idle").hidden).toBe(false));

        dispatchState({ state: "completed", partial: true });
        await vi.waitFor(() =>
            expect(node("view-completed").hidden).toBe(false),
        );
        expect(node("completion-check").hidden).toBe(true);
        expect(node("completion-message").textContent).toBe(
            "partialRecordingSent",
        );
    });

    it("checks the server while saving and stops checking after completion", async () => {
        const { node, sendMessage, dispatchState } = setupPopup(
            "https://example.com",
        );
        await import("../../../extensions/recorder/popup/popup.js");
        await vi.waitFor(() => expect(node("view-idle").hidden).toBe(false));

        vi.useFakeTimers();
        try {
            dispatchState({
                state: "finalizing",
                chunkCount: 4,
                uploaded: [0, 1, 2, 3],
                finalizingAt: new Date().toISOString(),
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(node("finalizing-processing").hidden).toBe(false);
            await vi.advanceTimersByTimeAsync(5000);
            expect(sendMessage).toHaveBeenCalledWith({
                type: "check-finalization",
            });

            dispatchState({ state: "completed", partial: false });
            await vi.advanceTimersByTimeAsync(0);
            const checks = sendMessage.mock.calls.filter(
                ([message]) => message.type === "check-finalization",
            ).length;
            await vi.advanceTimersByTimeAsync(5000);
            expect(
                sendMessage.mock.calls.filter(
                    ([message]) => message.type === "check-finalization",
                ),
            ).toHaveLength(checks);
        } finally {
            vi.useRealTimers();
        }
    });
});
