// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountRecordingControls } from "../../../extensions/recorder/lib/recording-controls.js";
import { roomRecorderClock } from "../../../extensions/recorder/lib/room-recorders.js";

const h = vi.hoisted(() => ({
    wait: Promise.resolve(),
    reset: vi.fn(),
    fieldOptions: null,
    recordingRender: vi.fn(),
    closeIdle: vi.fn(),
    closeRecording: vi.fn(),
}));
vi.mock("../../../extensions/recorder/generated/folders.js", () => ({
    createFolderField: (options) => {
        h.fieldOptions = options;
        return {
            reset: h.reset,
            saved: () => h.wait,
            close: h.closeIdle,
            destroy: vi.fn(),
        };
    },
    createRecordingFolder: () => ({
        render: h.recordingRender,
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
    vi.useFakeTimers({
        toFake: [
            "Date",
            "performance",
            "setTimeout",
            "clearTimeout",
            "setInterval",
            "clearInterval",
        ],
    });
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
            session: { get: async () => ({}) },
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

describe("room recorder notice", () => {
    const names = [
        "Robin Harper",
        "Jitka Dvořáková",
        "Alex Rowan",
        "Morgan Hill",
        "Jamie Lane",
    ];

    function configure(
        locale,
        recorders,
        variant,
        answer = () => ({
            names: recorders,
            expiresAt: roomRecorderClock() + 30_000,
        }),
    ) {
        const catalog = JSON.parse(
            readFileSync(
                `extensions/recorder/_locales/${locale}/messages.json`,
                "utf8",
            ),
        );
        chrome.i18n.getUILanguage = () => locale;
        chrome.i18n.getMessage = (key, replacement) =>
            catalog[key]?.message.replace("$1", () => replacement) ?? key;
        local.serverDefaults = { roomRecorders: 1 };
        chrome.tabs.query.mockResolvedValue([
            { id: 8, active: true, url: "https://zoom.us/j/123456789" },
        ]);
        const regular = chrome.runtime.sendMessage.getMockImplementation();
        chrome.runtime.sendMessage.mockImplementation((message) =>
            message.type === "room-recorders"
                ? Promise.resolve(answer())
                : regular(message),
        );
        return mountRecordingControls(document.body, {
            variant,
            ...(variant === "panel" ? { tabId: 7 } : {}),
        });
    }

    it.each([
        ["en", "popup", [names[0]], "Recording this meeting: Robin Harper"],
        [
            "en",
            "panel",
            names.slice(0, 2),
            "Recording this meeting: Robin Harper, Jitka Dvořáková",
        ],
        [
            "en",
            "popup",
            names,
            "Recording this meeting: Robin Harper, Jitka Dvořáková, Alex Rowan +2",
        ],
        ["en", "panel", [""], "Recording this meeting: A colleague"],
        ["cs", "panel", [names[0]], "Tuto schůzku nahrává: Robin Harper"],
        [
            "cs",
            "popup",
            names.slice(0, 2),
            "Tuto schůzku nahrávají: Robin Harper, Jitka Dvořáková",
        ],
        [
            "cs",
            "panel",
            names,
            "Tuto schůzku nahrávají: Robin Harper, Jitka Dvořáková, Alex Rowan +2",
        ],
        ["cs", "popup", [" "], "Tuto schůzku nahrává: Kolega"],
    ])("renders %s in the %s for %j", async (locale, variant, recorders, expected) => {
        widget = await configure(locale, recorders, variant);
        const notice = el("room-recorder-notice");
        expect(notice.hidden).toBe(false);
        expect(notice.textContent).toBe(expected);
        expect(notice.getAttribute("role")).toBe("status");
        expect(notice.querySelector("button")).toBeNull();
        expect(notice.nextElementSibling).toBe(el("idle-hint"));
        listener({ type: "state", state: { state: "awaiting-picker" } });
        await settle();
        expect(notice.hidden).toBe(true);
    });

    it("polls the popup every 15 seconds and expires names when the next lookup is pending", async () => {
        widget = await configure("en", [names[0]], "popup");
        const calls = () =>
            chrome.runtime.sendMessage.mock.calls.filter(
                ([message]) => message.type === "room-recorders",
            );
        expect(calls()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(calls()).toHaveLength(2);
        const regular = chrome.runtime.sendMessage.getMockImplementation();
        const pending = Promise.withResolvers();
        chrome.runtime.sendMessage.mockImplementation((message) =>
            message.type === "room-recorders"
                ? pending.promise
                : regular(message),
        );
        await vi.advanceTimersByTimeAsync(30_000);
        expect(el("room-recorder-notice").hidden).toBe(true);
        listener({
            type: "state",
            state: { state: "recording", sessionId: "mine" },
        });
        pending.resolve({ names, expiresAt: roomRecorderClock() + 30_000 });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(el("room-recorder-notice").hidden).toBe(true);
        expect(calls()).toHaveLength(3);
    });

    it.each([
        7_000, 14_000,
    ])("keeps naming a recording colleague when the shared worker entry expires %i ms after the first poll", async (remaining) => {
        let expiresAt = roomRecorderClock() + remaining;
        widget = await configure("en", [names[0]], "popup", () => {
            if (expiresAt <= roomRecorderClock())
                expiresAt = roomRecorderClock() + 30_000;
            return { names: [names[0]], expiresAt };
        });
        const notice = el("room-recorder-notice");
        expect(notice.hidden).toBe(false);

        await vi.advanceTimersByTimeAsync(remaining + 500);

        expect(notice.hidden).toBe(false);
        expect(notice.textContent).toBe("Recording this meeting: Robin Harper");
    });

    it("immediately re-asks when a positive answer arrives just after its expiry", async () => {
        const answer = vi
            .fn()
            .mockImplementationOnce(() => ({
                names: ["Expired"],
                expiresAt: roomRecorderClock() - 1,
            }))
            .mockImplementation(() => ({
                names: [names[0]],
                expiresAt: roomRecorderClock() + 30_000,
            }));
        widget = await configure("en", names, "popup", answer);
        await settle();
        expect(answer).toHaveBeenCalledTimes(2);
        expect(el("room-recorder-notice").textContent).toBe(
            "Recording this meeting: Robin Harper",
        );
    });

    it("leaves the notice empty when the room has nobody recording", async () => {
        widget = await configure("en", [], "panel");
        expect(el("room-recorder-notice").hidden).toBe(true);
    });
});

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
    it("keeps the click's protocol while a draft flush is pending", async () => {
        local.serverDefaults = { encryptedRecordingProtocol: 1 };
        const saving = Promise.withResolvers();
        const beforeAction = vi.fn(() => saving.promise);
        widget = await mountRecordingControls(document.body, {
            variant,
            beforeAction,
            tabId: 7,
        });
        el("start").click();
        await settle();
        expect(beforeAction).toHaveBeenCalledOnce();
        local.serverDefaults = {
            ...local.serverDefaults,
            offlineRecording: true,
            accountId: "account",
            offlineRecipient: {
                serverOrigin: local.serverUrl,
                accountId: "account",
            },
        };
        saving.resolve();
        await settle();
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "start-recording",
            payload: expect.objectContaining({
                startPath: expect.objectContaining({
                    recipient: null,
                    legacySupported: true,
                }),
            }),
        });
    });

    it("passes saved folder scope to the idle chip, start payload and recording chip", async () => {
        Object.assign(local, {
            folderId: "work",
            folderLabel: "Organization / Planning",
            folderScope: "org",
        });
        await mount();
        expect(h.reset).toHaveBeenCalledWith(
            expect.objectContaining({ folderScope: "org" }),
            undefined,
        );
        const choice = {
            folderId: "calls",
            folderLabel: "Private / Calls",
            folderScope: "personal",
        };
        await h.fieldOptions.save(choice);
        el("start").click();
        await settle();
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "start-recording",
            payload: expect.objectContaining(choice),
        });
        const state = {
            state: "recording",
            sessionId: "one",
            uploaded: [],
            ...choice,
        };
        listener({ type: "state", state });
        await settle();
        expect(h.recordingRender).toHaveBeenCalledWith(state, undefined);
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
                uploadNotice: "Access could not be verified",
            },
        });
        await settle();
        expect(el("view-finalizing").hidden).toBe(false);
        expect(el("processing-status").textContent).toContain(
            "Access could not be verified",
        );
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
    it("sends Stop while agenda and folder saves are still pending", async () => {
        const saving = Promise.withResolvers();
        h.wait = saving.promise;
        const beforeAction = vi.fn(() => saving.promise);
        widget = await mountRecordingControls(document.body, {
            variant,
            beforeAction,
        });
        el("stop").click();
        await settle();
        expect(beforeAction).toHaveBeenCalledOnce();
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "stop-recording",
            reason: "user",
        });
        saving.resolve();
    });
    it.each([
        [null, { noticeText: "Default", noticeTextIsDefault: true }, ""],
        [
            null,
            { noticeText: "Operator notice", noticeTextIsDefault: false },
            "Operator notice",
        ],
        [
            "User notice",
            { noticeText: "Default", noticeTextIsDefault: true },
            "User notice",
        ],
    ])("shows only customized participant notices (%s)", async (noticeText, serverDefaults, expected) => {
        Object.assign(local, { noticeText, serverDefaults });
        await mount();
        expect(el("notice-text").textContent).toBe(expected);
        expect(el("notice-text").hidden).toBe(!expected);
    });
    it("offers direct tab capture, the idle hint and picker hint away from a meeting", async () => {
        chrome.tabs.get.mockResolvedValue({
            id: 7,
            url: "https://example.com",
        });
        await mount();
        expect(el("start").hidden).toBe(false);
        expect(el("idle-hint").hidden).toBe(false);
        expect(el("picker-hint").hidden).toBe(false);
        expect(el("start-desktop").hidden).toBe(false);
        el("start").click();
        await settle();
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "start-recording",
            payload: expect.objectContaining({
                tabId: variant === "panel" ? 7 : 8,
                forceDesktop: false,
                platformHint: undefined,
            }),
        });
        if (variant === "panel")
            expect(document.querySelector("header").hidden).toBe(true);
    });
    it("keeps the complete next-meeting card in the recording block without requiring an agenda", async () => {
        local.serverDefaults = { nextMeeting: true };
        chrome.storage.session.get = async () => ({
            recorderNextMeeting: {
                serverUrl: local.serverUrl,
                connectionId: "1",
                data: {
                    title: "Team review",
                    start: new Date(Date.now() + 60000).toISOString(),
                    end: new Date(Date.now() + 3600000).toISOString(),
                    joinUrl: "https://meet.google.com/xyz-uvwx-rst",
                    accountEmail: "jitka@example.com",
                },
            },
        });
        await mount();
        await settle();
        expect(el("next-meeting-card").hidden).toBe(false);
        expect(
            el("next-meeting-card").querySelector("strong").textContent,
        ).toBe("Team review");
        expect(
            el("next-meeting-card").querySelector("button").textContent,
        ).toBe("joinMeet");
        expect(document.body.contains(el("next-meeting-card"))).toBe(true);
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

it("#403 places the colleague notice above the complete panel recording controls", async () => {
    const notice = document.createElement("p");
    notice.textContent = "Jitka Dvořáková is recording this meeting";
    widget = await mountRecordingControls(document.body, {
        variant: "panel",
        tabId: 7,
        idleNotice: notice,
    });
    expect(el("view-idle").contains(notice)).toBe(true);
    expect(notice.nextElementSibling).toBe(el("idle-hint"));
    for (const id of [
        "idle-hint",
        "folder-row",
        "start",
        "start-desktop",
        "picker-hint",
    ])
        expect(el(id).closest("[hidden]")).toBeNull();
    listener({
        type: "state",
        state: { state: "recording", sessionId: "one", uploaded: [] },
    });
    await settle();
    expect(notice.closest("[hidden]")).toBe(el("view-idle"));
    expect(el("view-recording").hidden).toBe(false);
});
