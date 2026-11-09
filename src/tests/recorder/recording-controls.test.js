// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountRecordingControls } from "../../../extensions/recorder/lib/recording-controls.js";

const h = vi.hoisted(() => ({
    wait: Promise.resolve(),
    reset: vi.fn(),
    closeIdle: vi.fn(),
    closeRecording: vi.fn(),
}));
vi.mock("../../../extensions/recorder/generated/folders.js", () => ({
    createFolderField: () => ({
        reset: h.reset,
        saved: () => h.wait,
        close: h.closeIdle,
        destroy: vi.fn(),
    }),
    createRecordingFolder: () => ({
        render: vi.fn(),
        saved: () => h.wait,
        close: h.closeRecording,
        destroy: vi.fn(),
    }),
}));
let widget;
let listener;
let local;
let close;
const el = (id) => document.getElementById(id);
beforeEach(() => {
    vi.useFakeTimers();
    h.wait = Promise.resolve();
    h.reset.mockClear();
    h.closeIdle.mockClear();
    h.closeRecording.mockClear();
    document.documentElement.innerHTML = readFileSync(
        "extensions/recorder/popup/popup.html",
        "utf8",
    );
    local = {
        serverUrl: "https://recorder.example.com",
        encryptedApiKey: { nonce: [1] },
        dataUseAcknowledgedAt: "now",
    };
    close = vi.spyOn(window, "close").mockImplementation(() => {});
    vi.stubGlobal("navigator", {
        permissions: { query: async () => ({ state: "granted" }) },
    });
    vi.stubGlobal("chrome", {
        i18n: { getMessage: (key) => key, getUILanguage: () => "en" },
        storage: {
            local: {
                get: async () => local,
                set: async (patch) => Object.assign(local, patch),
            },
            onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
        },
        runtime: {
            getURL: (path) => `chrome-extension://test/${path}`,
            openOptionsPage: vi.fn(),
            onMessage: {
                addListener: (fn) => {
                    listener = fn;
                },
                removeListener: vi.fn(),
            },
            sendMessage: vi.fn(async (message) =>
                message.type === "get-state"
                    ? { state: { state: "idle" } }
                    : { ok: true },
            ),
        },
        tabs: {
            get: vi.fn(async (id) => ({
                id,
                url: "https://meet.google.com/abc-defg-hij",
            })),
            query: vi.fn(async () => [{ id: 8, url: "https://example.com" }]),
            create: vi.fn(),
        },
    });
});
afterEach(() => {
    widget?.destroy();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
});
const settle = () => vi.advanceTimersByTimeAsync(0);

describe.each([
    "popup",
    "panel",
])("shared recording widget in %s", (variant) => {
    async function mount() {
        widget = await mountRecordingControls(document.body, {
            variant,
            ...(variant === "panel"
                ? { tabId: 7, agendaChoice: () => ({ agendaId: "agenda-one" }) }
                : {}),
        });
    }
    it("uses the correct tab and consent, waits for folder persistence, and closes only the popup", async () => {
        await mount();
        let release;
        h.wait = new Promise((resolve) => {
            release = resolve;
        });
        el("start").click();
        await settle();
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "start-recording" }),
        );
        release();
        await settle();
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "start-recording",
            payload: expect.objectContaining({
                tabId: variant === "panel" ? 7 : 8,
                forceDesktop: false,
                noticeAcknowledgedAt: expect.any(String),
                ...(variant === "panel" ? { agendaId: "agenda-one" } : {}),
            }),
        });
        expect(close).toHaveBeenCalledTimes(variant === "popup" ? 1 : 0);
    });
    it("keeps the sharing-dialog action available and renders finalization, errors and recovery", async () => {
        await mount();
        el("start-desktop").click();
        await settle();
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "start-recording",
                payload: expect.objectContaining({ forceDesktop: true }),
            }),
        );
        listener({
            type: "state",
            state: {
                state: "recording",
                sessionId: "one",
                startedAt: new Date().toISOString(),
                uploaded: [],
            },
        });
        await settle();
        expect(el("view-recording").hidden).toBe(false);
        el("stop").click();
        await settle();
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "stop-recording",
            reason: "user",
        });
        listener({
            type: "state",
            state: {
                state: "finalizing",
                chunkCount: 4,
                uploaded: [0, 1, 2, 3],
            },
        });
        await settle();
        expect(el("view-finalizing").hidden).toBe(false);
        listener({
            type: "state",
            state: {
                state: "error",
                error: "Refused",
                sessionId: "one",
                stopped: true,
                recoverablePrefix: 2,
                chunkCount: 4,
            },
        });
        await settle();
        expect(el("error-text").textContent).toBe("Refused");
        expect(el("partial-recovery").hidden).toBe(false);
        listener({
            type: "state",
            state: { state: "completed", agendaUnavailable: true },
        });
        await settle();
        expect(el("completion-agenda-notice").textContent).toBe(
            "agendaUnavailable",
        );
    });
    it("closes the folder chooser of a view the state hides", async () => {
        await mount();
        expect(el("view-idle").hidden).toBe(false);
        expect(h.closeIdle).not.toHaveBeenCalled();
        listener({
            type: "state",
            state: {
                state: "recording",
                sessionId: "one",
                startedAt: new Date().toISOString(),
                uploaded: [],
            },
        });
        await settle();
        expect(h.closeIdle).toHaveBeenCalled();
        h.closeRecording.mockClear();
        listener({
            type: "state",
            state: {
                state: "recording",
                sessionId: "one",
                stopped: true,
                chunkCount: 2,
                uploaded: [0],
            },
        });
        await settle();
        expect(el("view-finalizing").hidden).toBe(false);
        expect(h.closeRecording).toHaveBeenCalled();
    });
});
