import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

function setupPopup(tabUrl, folderId = null, folderLabel = null) {
    vi.stubGlobal("navigator", {
        permissions: { query: vi.fn(async () => ({ state: "granted" })) },
    });
    const nodes = new Map();
    let onMessage;
    const node = (id) => {
        if (!nodes.has(id)) {
            const listeners = new Map();
            nodes.set(id, {
                hidden: true,
                disabled: false,
                textContent: "",
                value: "",
                children: [],
                style: {},
                attributes: new Map(),
                setAttribute(name, value) {
                    this.attributes.set(name, value);
                },
                addEventListener: (type, listener) =>
                    listeners.set(type, listener),
                click: () => listeners.get("click")?.(),
                replaceChildren(...children) {
                    this.children = children;
                },
                append(...children) {
                    this.children.push(...children);
                },
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
        createElement: () => node(Symbol()),
    });
    vi.stubGlobal("window", { close });
    const storageSet = vi.fn().mockResolvedValue(undefined);
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
                    folderId,
                    folderLabel,
                }),
                set: storageSet,
            },
        },
        tabs: {
            query: async () => [{ id: 42, url: tabUrl }],
            create: vi.fn(async () => {}),
        },
        runtime: {
            getURL: (path) => `chrome-extension://test/${path}`,
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
        storageSet,
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
            false,
        ],
        ["other tab", "https://example.com", undefined, false],
        [
            "other screen or app",
            "https://example.com",
            undefined,
            false,
            true,
            true,
        ],
        [
            "server tab before consent",
            "https://example.com",
            undefined,
            false,
            false,
        ],
    ])("starts recording or setup from one confirmation click on a %s", async (_, url, platformHint, pickerHidden, consented = true, forceDesktop = false) => {
        const { node, sendMessage, close } = setupPopup(url);
        if (!consented) chrome.storage.local.get = async () => ({});
        await import("../../../extensions/recorder/popup/popup.js");
        if (!consented) {
            await vi.waitFor(() =>
                expect(node("view-connect").hidden).toBe(false),
            );
            await node("connect-origin").click();
            expect(chrome.tabs.create).toHaveBeenCalledWith({
                url: "chrome-extension://test/options/options.html?origin=https%3A%2F%2Fexample.com&tabId=42",
            });
            expect(close).toHaveBeenCalledOnce();
            return;
        }
        await vi.waitFor(() => expect(node("view-idle").hidden).toBe(false));

        expect(node("picker-hint").hidden).toBe(pickerHidden);
        await node(forceDesktop ? "start-desktop" : "start").click();

        const startCalls = sendMessage.mock.calls.filter(
            ([message]) => message.type === "start-recording",
        );
        expect(startCalls).toHaveLength(1);
        expect(startCalls[0][0].payload).toMatchObject({
            tabId: 42,
            forceDesktop,
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

    it.each([
        false,
        true,
    ])("shows progress for desktop=%s while Chrome handles the capture request", async (desktop) => {
        const { node, sendMessage, close } = setupPopup("https://example.com");
        let finishStart;
        sendMessage.mockImplementation((message) =>
            message.type === "get-state"
                ? Promise.resolve({ state: { state: "idle" } })
                : message.type === "start-recording"
                  ? new Promise((resolve) => {
                        finishStart = resolve;
                    })
                  : Promise.resolve({ ok: true, folders: [] }),
        );
        await import("../../../extensions/recorder/popup/popup.js");
        await vi.waitFor(() => expect(node("view-idle").hidden).toBe(false));

        const button = node(desktop ? "start-desktop" : "start");
        const start = button.click();
        expect(node("start").disabled).toBe(true);
        expect(node("start-desktop").disabled).toBe(true);
        expect(button.textContent).toBe(
            desktop ? "openingPicker" : "startingCapture",
        );
        expect(close).not.toHaveBeenCalled();

        await vi.waitFor(() => expect(finishStart).toBeTypeOf("function"));
        finishStart({ ok: true });
        await start;
        expect(close).toHaveBeenCalledOnce();
    });

    it("renders the idle view before the remembered folder responds", async () => {
        const { node, sendMessage, storageSet, close } = setupPopup(
            "https://example.com",
            "folder-1",
            "Private / Previous",
        );
        let finishFolders;
        sendMessage.mockImplementation((message) =>
            message.type === "get-state"
                ? Promise.resolve({ state: { state: "idle" } })
                : message.type === "get-folders"
                  ? new Promise((resolve) => {
                        finishFolders = resolve;
                    })
                  : Promise.resolve({ ok: true }),
        );

        await import("../../../extensions/recorder/popup/popup.js");
        await vi.waitFor(() => expect(node("view-idle").hidden).toBe(false));
        expect(node("start").textContent).toBe("recordTabWithConsent");
        expect(finishFolders).toBeTypeOf("function");

        finishFolders({
            ok: true,
            folders: [
                {
                    id: "folder-1",
                    label: "Private / Calls",
                },
            ],
        });
        await vi.waitFor(() =>
            expect(node("folder-listbox").children).toHaveLength(2),
        );
        await node("start").click();
        expect(storageSet).toHaveBeenCalledWith({
            folderId: "folder-1",
            folderLabel: "Private / Calls",
        });
        expect(close).toHaveBeenCalledOnce();
    });

    it("shows the remembered folder label before the folder list responds", async () => {
        const { node, sendMessage, storageSet, close } = setupPopup(
            "https://example.com",
            "folder-1",
            "Private / Calls",
        );
        let finishFolders;
        sendMessage.mockImplementation((message) =>
            message.type === "get-state"
                ? Promise.resolve({ state: { state: "idle" } })
                : message.type === "get-folders"
                  ? new Promise((resolve) => {
                        finishFolders = resolve;
                    })
                  : Promise.resolve({ ok: true }),
        );

        await import("../../../extensions/recorder/popup/popup.js");
        await vi.waitFor(() => expect(node("view-idle").hidden).toBe(false));
        expect(node("folder-picker").value).toBe("Private / Calls\u200E");
        expect(node("folder-listbox").children[1].textContent).toBe(
            "Private / Calls",
        );

        await node("start").click();

        expect(sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "start-recording" }),
        );
        expect(storageSet).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
        finishFolders?.({ ok: true, folders: [] });
    });

    it("uses the localized saved-folder label when the remembered folder has no label", async () => {
        const { node, sendMessage } = setupPopup(
            "https://example.com",
            "folder-1",
        );
        sendMessage.mockImplementation((message) =>
            message.type === "get-state"
                ? Promise.resolve({ state: { state: "idle" } })
                : message.type === "get-folders"
                  ? new Promise(() => {})
                  : Promise.resolve({ ok: true }),
        );

        await import("../../../extensions/recorder/popup/popup.js");
        await vi.waitFor(() => expect(node("view-idle").hidden).toBe(false));
        expect(node("folder-listbox").children[1].textContent).toBe(
            "savedFolder",
        );
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
