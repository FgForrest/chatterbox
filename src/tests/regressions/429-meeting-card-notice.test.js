// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../extensions/recorder/popup/folder-combobox.js";
import {
    arm,
    extension,
    h,
    meeting,
    message,
    mockToolbarFrames,
    offscreen,
    sender,
    settle,
    startFromPopup,
} from "../recorder/meeting-worker-fixture.js";

import "../../../extensions/recorder/lib/recording-levels.js";

const source = readFileSync("extensions/recorder/content-meeting.js", "utf8");
const messages = JSON.parse(
    readFileSync("extensions/recorder/_locales/en/messages.json", "utf8"),
);
const popup = "popup/popup.html";

function event() {
    const listeners = [];
    return {
        addListener: (fn) => listeners.push(fn),
        emit: (...args) => {
            for (const fn of listeners) fn(...args);
        },
    };
}

function port(from) {
    const onDisconnect = event();
    return {
        name: "meeting-levels",
        sender: from,
        onDisconnect,
        onMessage: event(),
        disconnect: vi.fn(() => onDisconnect.emit()),
        postMessage: vi.fn(),
    };
}

function mountCard() {
    const attach = Element.prototype.attachShadow;
    let root;
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(
        function (options) {
            root = attach.call(this, options);
            return root;
        },
    );
    const incoming = event();
    const runtime = {
        id: "test",
        onMessage: incoming,
        connect: vi.fn(() => port(sender())),
        sendMessage: vi.fn(async () => ({ ok: true })),
    };
    const render = (view, payload) => {
        const respond = vi.fn();
        incoming.emit(
            { type: "meeting-banner", view, ...payload },
            { id: "test" },
            respond,
        );
        return respond.mock.lastCall?.[0];
    };
    new Function("chrome", source)({
        runtime,
        i18n: {
            getUILanguage: () => "en",
            getMessage: (key, substitutions = []) =>
                [substitutions]
                    .flat()
                    .reduce(
                        (copy, value, index) =>
                            copy.replaceAll(`$${index + 1}`, value),
                        messages[key]?.message ?? key,
                    ),
        },
    });
    return { root, runtime, render };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete globalThis.recorderMeetingBanner;
    document.getElementById("recorder-meeting-banner")?.remove();
});

it.each([
    ["en", /toolbar.*then choose “\$2”/],
    ["cs", /liště Chromu a zvolte „\$2“/],
])("describes both manual recording clicks in %s", (locale, flow) => {
    const catalog = JSON.parse(
        readFileSync(
            `extensions/recorder/_locales/${locale}/messages.json`,
            "utf8",
        ),
    );
    expect(catalog.meetingRecordBody.message).toMatch(flow);
    expect(catalog.setupReadyHint.message).toContain(
        catalog.recordTabWithConsent.message,
    );
});

describe("meeting card", () => {
    it.each([
        "pinned",
        "unpinned",
        "agenda",
        "policy",
        "unreachable",
    ])("has only the close button when %s", async (variant) => {
        const { root, runtime, render } = mountCard();
        render("prompt", {
            pinned: variant !== "unpinned",
            shortcut: "Alt+Shift+R",
            notice: "Inform participants.",
            ...(variant === "agenda"
                ? {
                      agendaPanel: true,
                      agendas: [{ id: "agenda", title: "Planning" }],
                  }
                : {}),
            ...(variant === "policy" ? { policyRequired: true } : {}),
            ...(variant === "unreachable"
                ? {
                      disconnected: true,
                      connection: {
                          message: "Server unavailable",
                          detail: "No answer within 30 s.",
                      },
                  }
                : {}),
        });
        expect(
            [...root.querySelectorAll("button")].map((button) => button.id),
        ).toEqual(["close"]);
        expect(root.querySelector(".notice").textContent).toContain(
            "Inform participants.",
        );
        if (variant === "unreachable") {
            expect(root.getElementById("how")).toBeNull();
            expect(root.querySelector("kbd")).toBeNull();
            expect(
                root.getElementById("meeting-connection").textContent,
            ).toContain("No answer within 30 s.");
            expect(
                root.getElementById("meeting-connection").textContent,
            ).toMatch(/start.*reachable/i);
            render("prompt", { pinned: true, blinkUntil: Date.now() + 2000 });
            expect(root.getElementById("how").textContent).toContain(
                "blinking",
            );
            expect(root.querySelector(".prompt-main").textContent).toContain(
                messages.recordTabWithConsent.message,
            );
        } else if (["pinned", "unpinned"].includes(variant)) {
            expect(root.querySelector(".prompt-main").textContent).toContain(
                messages.recordTabWithConsent.message,
            );
        }
        root.getElementById("close").click();
        await Promise.resolve();
        expect(runtime.sendMessage).toHaveBeenLastCalledWith({
            type: "meeting-banner-dismiss",
        });
        expect(root.host.isConnected).toBe(false);
    });

    it("acknowledges shortcut consent only when it shows the shortcut wording", () => {
        const { render } = mountCard();
        const prompt = { pinned: true, shortcut: "Alt+Shift+R" };
        expect(render("prompt", { ...prompt, disconnected: true })).toEqual({
            visible: true,
            consentShown: false,
        });
        expect(render("prompt", { ...prompt, agendaPanel: true })).toEqual({
            visible: true,
            consentShown: false,
        });
        expect(render("prompt", { ...prompt, policyRequired: true })).toEqual({
            visible: true,
            consentShown: false,
        });
        expect(render("prompt", { ...prompt, shortcut: "" })).toEqual({
            visible: true,
            consentShown: false,
        });
        expect(render("prompt", prompt)).toEqual({
            visible: true,
            consentShown: true,
        });
        render("hidden");
    });

    it("reconnects to a disconnected worker with capped backoff and cancels on collapse", () => {
        vi.spyOn(document, "hidden", "get").mockReturnValue(false);
        const { root, runtime, render } = mountCard();
        vi.useFakeTimers();
        try {
            render("recording", { state: { sessionId: "session-1" } });
            const disconnect = () =>
                runtime.connect.mock.results.at(-1).value.onDisconnect.emit();
            for (const [index, delay] of [1000, 2000, 4000, 5000].entries()) {
                disconnect();
                vi.advanceTimersByTime(delay - 1);
                expect(runtime.connect).toHaveBeenCalledTimes(index + 1);
                vi.advanceTimersByTime(1);
                expect(runtime.connect).toHaveBeenCalledTimes(index + 2);
            }
            runtime.connect.mock.results
                .at(-1)
                .value.onMessage.emit({ micDb: -35, systemDb: -40 });
            disconnect();
            vi.advanceTimersByTime(1000);
            expect(runtime.connect).toHaveBeenCalledTimes(6);
            disconnect();
            root.getElementById("dot-toggle").click();
            vi.advanceTimersByTime(5500);
            expect(runtime.connect).toHaveBeenCalledTimes(6);
            render("hidden");
        } finally {
            vi.useRealTimers();
        }
    });

    it("subscribes only for the visible expanded pill and clears a stalled meter", () => {
        const hidden = vi
            .spyOn(document, "hidden", "get")
            .mockReturnValue(false);
        const { root, runtime, render } = mountCard();
        vi.useFakeTimers();
        try {
            render("prompt", { pinned: true });
            expect(runtime.connect).not.toHaveBeenCalled();
            render("recording", {
                state: {
                    sessionId: "session-1",
                    recordingFolderOverride: true,
                },
            });
            expect(runtime.connect).toHaveBeenCalledWith({
                name: "meeting-levels",
            });
            const first = runtime.connect.mock.results[0].value;
            const heights = (id) =>
                [...root.querySelectorAll(`#${id} .level-fill`)].map(
                    (bar) => bar.style.height,
                );
            expect(
                root.querySelectorAll("#mic-level .level-fill"),
            ).toHaveLength(4);
            expect(
                root.querySelectorAll("#system-level .level-fill"),
            ).toHaveLength(4);
            first.onMessage.emit({
                micDb: -30,
                systemDb: -15,
                micBands: [-100, -45, -30, 0],
                systemBands: [-15, -30, -60, -45],
            });
            expect(heights("mic-level")).toEqual(["2px", "5px", "8px", "14px"]);
            expect(heights("system-level")).toEqual([
                "11px",
                "8px",
                "2px",
                "5px",
            ]);
            first.onMessage.emit({ micDb: -30, systemDb: -15 });
            expect(heights("mic-level")).toEqual(Array(4).fill("8px"));
            expect(heights("system-level")).toEqual(Array(4).fill("11px"));
            vi.advanceTimersByTime(1000);
            expect(heights("mic-level")).toEqual(Array(4).fill("2px"));
            expect(heights("system-level")).toEqual(Array(4).fill("2px"));
            root.getElementById("dot-toggle").click();
            expect(first.disconnect).toHaveBeenCalledOnce();
            root.getElementById("dot-toggle").click();
            const second = runtime.connect.mock.results[1].value;
            hidden.mockReturnValue(true);
            document.dispatchEvent(new Event("visibilitychange"));
            expect(second.disconnect).toHaveBeenCalledOnce();
            hidden.mockReturnValue(false);
            document.dispatchEvent(new Event("visibilitychange"));
            const third = runtime.connect.mock.results[2].value;
            root.getElementById("stop").click();
            expect(third.disconnect).toHaveBeenCalledOnce();
            render("stopped", { state: { sessionId: "session-1" } });
            expect(runtime.connect).toHaveBeenCalledTimes(3);
            render("hidden");
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });
});

describe("meeting tab worker", () => {
    afterEach(async () => {
        await h.listeners.updated(7, { status: "loading" }, meeting);
    });

    it("keeps the popup and never starts capture on an action click from a prompt tab", async () => {
        await arm();
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup,
        });
        h.listeners.clicked(h.tabs.get(7));
        await settle();
        expect(h.createSession).not.toHaveBeenCalled();
        expect(chrome.runtime.openOptionsPage).not.toHaveBeenCalled();
    });

    it("opens the popup if a click reaches onClicked before Auto routing is replaced", async () => {
        const openPopup = vi.fn(async () => {});
        const action = chrome.action;
        vi.stubGlobal("chrome", {
            ...chrome,
            action: { ...action, openPopup },
        });
        await arm();
        action.setPopup.mockClear();
        h.listeners.clicked(h.tabs.get(7));
        await vi.waitFor(() => expect(openPopup).toHaveBeenCalledOnce());
        expect(action.setPopup).toHaveBeenCalledWith({ tabId: 7, popup });
        expect(h.createSession).not.toHaveBeenCalled();
    });

    it.each([
        "popup",
        "panel",
        "shortcut",
        "auto",
    ])("aborts a %s start if the tab changes meetings during session creation", async (surface) => {
        if (surface === "auto") {
            h.local.platformModes = { "google-meet": "auto" };
            h.local.autoModeAcknowledgedAt = "2026-10-20T12:00:00Z";
        }
        await arm();
        const creating = Promise.withResolvers();
        const created = Promise.withResolvers();
        h.createSession.mockImplementationOnce(() => {
            creating.resolve();
            return created.promise;
        });
        let request;
        if (surface === "popup") request = startFromPopup();
        else if (surface === "panel")
            request = message(
                {
                    type: "start-recording",
                    payload: {
                        tabId: 7,
                        noticeAcknowledgedAt: "2026-10-20T12:30:00Z",
                    },
                },
                {
                    ...extension,
                    url: "chrome-extension://test/agenda/agenda.html?tab=7",
                },
            );
        else if (surface === "shortcut")
            request = h.listeners.command("toggle-recording");
        else h.listeners.clicked(h.tabs.get(7));
        await creating.promise;
        h.tabs.set(7, {
            ...meeting,
            url: "https://meet.google.com/xyz-abcd-efg",
        });
        created.resolve({
            id: "session-1",
            encryption: { protocol: 1, key: "test-key" },
        });
        const result = await request;
        if (surface === "popup" || surface === "panel") {
            expect(result).toMatchObject({
                ok: false,
                error: "recordingRequestExpired",
            });
        } else {
            await vi.waitFor(() =>
                expect(chrome.notifications.create).toHaveBeenCalledWith(
                    undefined,
                    expect.objectContaining({
                        title: "couldNotStart",
                        message: "recordingRequestExpired",
                    }),
                ),
            );
        }
        expect(h.abortSession).toHaveBeenCalledWith(
            expect.anything(),
            "session-1",
        );
        expect(h.metas.has("session-1")).toBe(false);
        expect(chrome.tabCapture.getMediaStreamId).not.toHaveBeenCalled();
    });

    it("rejects a popup request bound to the previous meeting before creating a session", async () => {
        h.tabs.set(7, {
            ...meeting,
            url: "https://meet.google.com/xyz-abcd-efg",
        });
        const result = await startFromPopup({
            meetingTarget: {
                origin: "https://meet.google.com",
                platformId: "google-meet",
                meetingId: "abc-defg-hij",
            },
        });
        expect(result).toEqual({ ok: false, error: "recordingRequestExpired" });
        expect(h.createSession).not.toHaveBeenCalled();
        expect(chrome.tabCapture.getMediaStreamId).not.toHaveBeenCalled();
    });

    it("routes picker levels to the meeting tab that launched the recording", async () => {
        await arm();
        expect(await startFromPopup({ forceDesktop: true })).toMatchObject({
            ok: true,
            pending: true,
        });
        const { pickerRequestId: requestId, captureWindowId } =
            h.session.recordingState;
        const picker = {
            id: "test",
            url: `chrome-extension://test/picker/picker.html?requestId=${requestId}`,
            tab: { windowId: captureWindowId },
        };
        expect(
            await message({ type: "desktop-capture-ready", requestId }, picker),
        ).toEqual({ ok: true });
        expect(h.session.recordingState).toMatchObject({
            tabId: 7,
            captureMode: "desktop",
        });
        expect(chrome.tabCapture.getMediaStreamId).not.toHaveBeenCalled();

        const launchingTab = port(sender());
        for (const connect of h.listeners.connect) connect(launchingTab);
        await settle();
        h.listeners.message(
            {
                type: "levels",
                sessionId: "session-1",
                micDb: -35,
                systemDb: -12,
            },
            picker,
            () => {},
        );
        await settle();
        expect(launchingTab.postMessage).toHaveBeenCalledWith({
            micDb: -35,
            systemDb: -12,
        });
        launchingTab.disconnect();
    });

    it("requires a reachable shortcut acknowledgement after the first notice appeared offline", async () => {
        h.session.serverConnection = {
            serverUrl: h.local.serverUrl,
            connectionId: null,
            state: "unreachable",
            detail: { kind: "timeout" },
        };
        await arm();
        expect(h.session.armedTabs[7]).toMatchObject({
            promptVisible: true,
            consentShown: false,
        });
        h.session.serverConnection = {
            ...h.session.serverConnection,
            state: "ok",
        };
        await h.listeners.command("toggle-recording");
        expect(h.createSession).not.toHaveBeenCalled();
        expect(chrome.runtime.openOptionsPage).toHaveBeenCalledOnce();
        await message({ type: "meeting-banner-ready" });
        expect(h.session.armedTabs[7].consentShown).toBe(true);
        await h.listeners.command("toggle-recording");
        expect(h.createSession).toHaveBeenCalledOnce();
    });

    it.each([
        true,
        false,
    ])("stamps the saved policy acknowledgement on a manual shortcut start with card consent=%s", async (visible) => {
        const acknowledgedAt = "2026-10-20T12:00:00Z";
        h.local.autoModeAcknowledgedAt = acknowledgedAt;
        h.visible = visible;
        await arm();
        expect(h.session.armedTabs[7]).toMatchObject({
            mode: "prompt",
            consentShown: visible,
        });
        await h.listeners.command("toggle-recording");
        expect(h.createSession).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ noticeAcknowledgedAt: acknowledgedAt }),
        );
        expect(h.session.recordingState.state).toBe("recording");
        expect(chrome.runtime.openOptionsPage).not.toHaveBeenCalled();
    });

    it("reports a connection error if the server goes offline after the shortcut wording was shown", async () => {
        await arm();
        expect(h.session.armedTabs[7].consentShown).toBe(true);
        h.session.serverConnection = {
            serverUrl: h.local.serverUrl,
            connectionId: null,
            state: "unreachable",
            detail: { kind: "timeout" },
        };
        h.createSession.mockRejectedValueOnce(
            Object.assign(new Error("Timed out"), { kind: "unreachable" }),
        );
        await h.listeners.command("toggle-recording");
        expect(h.session.recordingState).toMatchObject({
            state: "error",
            startConnectionError: true,
        });
        expect(chrome.runtime.openOptionsPage).not.toHaveBeenCalled();
    });

    it.each([
        "popup",
        "shortcut",
        "pill",
        "auto-quiet",
    ])("closes level ports when %s stops capture before flush", async (surface) => {
        await arm();
        expect(await startFromPopup()).toMatchObject({ ok: true });
        const client = port(sender());
        for (const connect of h.listeners.connect) connect(client);
        await settle();
        expect(client.disconnect).not.toHaveBeenCalled();
        const requested = Promise.withResolvers();
        const acknowledge = Promise.withResolvers();
        const send = chrome.runtime.sendMessage.getMockImplementation();
        chrome.runtime.sendMessage.mockImplementation((payload) => {
            if (payload.type === "stop" && payload.target === "offscreen") {
                requested.resolve();
                return acknowledge.promise;
            }
            return send(payload);
        });
        try {
            let stop;
            if (surface === "popup")
                stop = message({ type: "stop-recording" }, extension);
            else if (surface === "shortcut")
                stop = h.listeners.command("toggle-recording");
            else if (surface === "pill")
                stop = message({
                    type: "stop-recording",
                    sessionId: "session-1",
                });
            else {
                h.session.recordingState.autoStarted = true;
                h.tabs.get(7).audible = false;
                stop = h.listeners.alarm({ name: "quiet:7" });
            }
            try {
                await requested.promise;
                expect(client.disconnect).toHaveBeenCalledOnce();
                const reopened = port(sender());
                for (const connect of h.listeners.connect) connect(reopened);
                await settle();
                expect(reopened.disconnect).toHaveBeenCalledOnce();
                expect(h.session.recordingState.stopped).toBe(false);
            } finally {
                acknowledge.resolve({ ok: true });
                await stop;
            }
        } finally {
            chrome.runtime.sendMessage.mockImplementation(send);
        }
    });

    it("replaces the prompt and its blinking badge when the popup starts recording", async () => {
        mockToolbarFrames();
        await arm();
        await vi.waitFor(() =>
            expect(chrome.action.setIcon).toHaveBeenCalledWith(
                expect.objectContaining({ imageData: expect.anything() }),
            ),
        );
        expect(await startFromPopup()).toMatchObject({ ok: true });
        expect(chrome.tabCapture.getMediaStreamId).toHaveBeenCalledWith(
            { targetTabId: 7 },
            expect.any(Function),
        );
        expect(h.session.armedTabs[7]).toMatchObject({
            bannerPrompt: false,
            promptVisible: false,
        });
        expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(
            7,
            expect.objectContaining({ view: "recording" }),
            { frameId: 0 },
        );
        await vi.waitFor(() =>
            expect(chrome.action.setIcon).toHaveBeenLastCalledWith(
                expect.objectContaining({ path: expect.anything() }),
            ),
        );
        expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({
            tabId: 7,
            text: "REC",
        });
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup,
        });
    });

    it("begins the blink after recovery only if the prompt has not already blinked", async () => {
        mockToolbarFrames();
        const outcome = (state) =>
            message(
                {
                    type: "recorder-connection-outcome",
                    outcome: {
                        config: true,
                        state,
                        serverUrl: h.local.serverUrl,
                        connectionId: null,
                        checkedAt: Date.now(),
                        detail: state === "ok" ? null : { kind: "timeout" },
                    },
                },
                extension,
            );
        const expectPrompt = (fields) =>
            expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(
                7,
                expect.objectContaining({ view: "prompt", ...fields }),
                { frameId: 0 },
            );
        await outcome("unreachable");
        await arm();
        expectPrompt({
            disconnected: true,
            blinkUntil: null,
            connection: expect.objectContaining({
                detail: "connectionTimeoutDetail",
            }),
        });
        expect(chrome.action.setIcon).not.toHaveBeenCalled();
        await outcome("ok");
        await vi.waitFor(() =>
            expectPrompt({
                disconnected: false,
                blinkUntil: expect.any(Number),
            }),
        );
        await vi.waitFor(() =>
            expect(chrome.action.setIcon).toHaveBeenCalledWith(
                expect.objectContaining({ imageData: expect.anything() }),
            ),
        );
        await outcome("unreachable");
        await vi.waitFor(() =>
            expectPrompt({ disconnected: true, blinkUntil: null }),
        );
        await vi.waitFor(() =>
            expect(chrome.action.setIcon).toHaveBeenLastCalledWith(
                expect.objectContaining({ path: expect.anything() }),
            ),
        );
        chrome.action.getUserSettings.mockResolvedValue({ isOnToolbar: false });
        h.listeners.pinChanged({ isOnToolbar: false });
        await vi.waitFor(() =>
            expectPrompt({
                pinned: false,
                disconnected: true,
                blinkUntil: null,
            }),
        );
        await outcome("ok");
        await vi.waitFor(() =>
            expectPrompt({
                pinned: false,
                disconnected: false,
                blinkUntil: null,
            }),
        );
        chrome.action.setIcon.mockClear();
        chrome.action.getUserSettings.mockResolvedValue({ isOnToolbar: true });
        h.listeners.pinChanged({ isOnToolbar: true });
        await vi.waitFor(() =>
            expectPrompt({
                pinned: true,
                disconnected: false,
                blinkUntil: null,
            }),
        );
        expect(chrome.action.setIcon).not.toHaveBeenCalled();
    });

    it("throttles levels and forwards only the current recording's validated levels to its top frame", async () => {
        await arm();
        expect(await startFromPopup()).toMatchObject({ ok: true });
        h.tabs.set(8, { ...meeting, id: 8 });
        const listeners = h.listeners.connect;
        const good = port(sender());
        const otherTab = port({ ...sender(), tab: { id: 8 } });
        const otherFrame = port({ ...sender(), frameId: 1 });
        for (const client of [good, otherTab, otherFrame])
            for (const connect of listeners) connect(client);
        await settle();
        expect(otherTab.disconnect).toHaveBeenCalledOnce();
        expect(otherFrame.disconnect).toHaveBeenCalledOnce();
        const micBands = [-40, -10, -65, -25];
        const systemBands = [-42, -32, -23, -62];
        const levels = (
            micDb,
            sessionId = "session-1",
            bands = { micBands, systemBands },
        ) =>
            h.listeners.message(
                {
                    type: "levels",
                    sessionId,
                    micDb,
                    systemDb: -15,
                    ...bands,
                    extra: "ignored",
                },
                offscreen,
                () => {},
            );
        levels(-30, "old-session");
        levels(-20);
        levels(-10);
        await settle();
        expect(good.postMessage.mock.calls).toEqual([
            [{ micDb: -20, systemDb: -15, micBands, systemBands }],
        ]);
        expect(otherTab.postMessage).not.toHaveBeenCalled();
        expect(otherFrame.postMessage).not.toHaveBeenCalled();
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now + 126);
        levels(-5, "session-1", { micBands: [0, 0, 0, "bad"], systemBands });
        await settle();
        expect(good.postMessage).toHaveBeenLastCalledWith({
            micDb: -5,
            systemDb: -15,
            systemBands,
        });
        expect(good.postMessage).toHaveBeenCalledTimes(2);
        clock.mockRestore();
        good.disconnect();
        levels(-3);
        await settle();
        expect(good.postMessage).toHaveBeenCalledTimes(2);
    });
});
