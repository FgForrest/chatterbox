import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEETING_PROMPT_SCRIPT_ID } from "../../../extensions/recorder/lib/meeting-prompt.js";
import { meetingTarget } from "../../../extensions/recorder/lib/meeting-target.js";
import { MEETING_PROMPT_ORIGINS } from "../../../extensions/recorder/lib/platforms.js";
import { createPromptIconBlink } from "../../../extensions/recorder/lib/prompt-icon.js";
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
} from "./meeting-worker-fixture.js";

async function start() {
    await arm();
    expect(await startFromPopup()).toMatchObject({ ok: true });
    await vi.waitFor(() =>
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ target: "offscreen", type: "start" }),
        ),
    );
    await settle();
}

describe("meeting prompt toolbar icon", () => {
    const tabId = 7;
    const normal = expect.objectContaining({
        tabId,
        path: expect.objectContaining({ 16: "icons/icon-16.png" }),
    });
    const image = (fillStyle) => ({
        imageData: expect.objectContaining({
            16: { width: 16, fillStyle },
            32: { width: 32, fillStyle },
        }),
        tabId,
    });
    const expectBadge = (text) =>
        expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({
            tabId,
            text,
        });

    beforeEach(mockToolbarFrames);

    afterEach(async () => {
        await h.listeners.updated(tabId, { status: "loading" }, meeting);
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("alternates 16- and 32-pixel frames for 20 seconds and keeps REC? after restoring", async () => {
        vi.useFakeTimers();
        await arm();
        await vi.advanceTimersByTimeAsync(0);
        expect(chrome.action.setIcon).toHaveBeenLastCalledWith(
            image("#f35f6d"),
        );
        expectBadge("");
        expect(
            chrome.action.setIcon.mock.invocationCallOrder.at(-1),
        ).toBeLessThan(
            chrome.action.setBadgeText.mock.invocationCallOrder.at(-1),
        );
        await message({ type: "meeting-banner-ready" });
        expectBadge("");
        chrome.action.setBadgeBackgroundColor.mockClear();
        await vi.advanceTimersByTimeAsync(600);
        expect(chrome.action.setIcon).toHaveBeenLastCalledWith(image("#000"));
        expectBadge("REC?");
        expect(chrome.action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({
            tabId,
            color: "#d33",
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(chrome.action.setIcon).toHaveBeenLastCalledWith(
            image("#f35f6d"),
        );
        expectBadge("");
        await vi.advanceTimersByTimeAsync(18_600);
        chrome.action.setBadgeText.mockClear();
        await vi.advanceTimersByTimeAsync(200);
        expect(chrome.action.setIcon).toHaveBeenLastCalledWith(normal);
        expectBadge("REC?");
        const frames = chrome.action.setIcon.mock.calls.length;
        await arm();
        await vi.advanceTimersByTimeAsync(25_000);
        expect(chrome.action.setIcon).toHaveBeenCalledTimes(frames);
    });

    it("keeps the prompt blinking through non-recording state writes", async () => {
        vi.useFakeTimers();
        const blinkUntil = Date.now() + 20_000;
        await arm();
        await vi.advanceTimersByTimeAsync(0);
        expectBadge("");
        h.session.recordingState = {
            tabId,
            state: "error",
            startConnectionError: true,
        };
        chrome.action.setBadgeText.mockClear();
        h.listeners.message(
            { type: "levels", micDb: -30, systemDb: -20 },
            offscreen,
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(h.session.recordingState.levels).toEqual({
            micDb: -30,
            systemDb: -20,
        });
        expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(
            tabId,
            { type: "meeting-banner-blink-stopped", blinkUntil },
            { frameId: 0 },
        );
        expect(chrome.action.setBadgeText).not.toHaveBeenCalled();
        await message({ type: "meeting-banner-ready" });
        expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(
            tabId,
            expect.objectContaining({ view: "prompt", blinkUntil }),
            { frameId: 0 },
        );
        await vi.advanceTimersByTimeAsync(600);
        expect(chrome.action.setIcon).toHaveBeenLastCalledWith(image("#000"));
        expectBadge("REC?");
        await vi.advanceTimersByTimeAsync(600);
        expect(chrome.action.setIcon).toHaveBeenLastCalledWith(
            image("#f35f6d"),
        );
        expectBadge("");
        await vi.advanceTimersByTimeAsync(18_800);
        expect(chrome.action.setIcon).toHaveBeenLastCalledWith(normal);
        expectBadge("REC?");

        chrome.action.setBadgeText.mockClear();
        h.listeners.message(
            { type: "levels", micDb: -40, systemDb: -20 },
            offscreen,
        );
        await vi.advanceTimersByTimeAsync(0);
        expectBadge("REC?");
    });

    it("clears REC when a recording finishes on a non-armed tab", async () => {
        vi.useFakeTimers();
        h.tabs.set(tabId, { ...meeting, url: "https://example.com/" });
        expect(
            await message(
                {
                    type: "start-recording",
                    payload: { tabId, noticeAcknowledgedAt: "yes" },
                },
                extension,
            ),
        ).toMatchObject({ ok: true, sessionId: "session-1" });
        expect(h.session.armedTabs?.[tabId]).toBeUndefined();
        expectBadge("REC");

        h.session.recordingState.uploaded = [0];
        h.completeSession.mockResolvedValueOnce({ status: "completed" });
        h.getSession.mockResolvedValueOnce({
            status: "completed",
            recording_id: "recording-1",
        });
        h.listeners.message(
            {
                type: "recording-stopped",
                sessionId: "session-1",
                chunkCount: 1,
            },
            offscreen,
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(h.session.recordingState.state).toBe("completed");
        expectBadge("");
        await vi.advanceTimersByTimeAsync(3_900);
        expect(h.session.recordingState).toBeUndefined();
    });

    it.each([
        ["hide", "REC?"],
        ["dismiss", "REC?"],
        ["recording", "REC"],
        ["navigation", ""],
        ["microphone reminder", "MIC!"],
        ["tab close", ""],
    ])("restores without further ticks on %s", async (reason, badge) => {
        vi.useFakeTimers();
        await arm();
        await vi.advanceTimersByTimeAsync(0);
        expect(chrome.action.setIcon).toHaveBeenCalledWith(image("#f35f6d"));
        expectBadge("");
        chrome.action.setBadgeText.mockClear();
        switch (reason) {
            case "hide":
                h.visible = false;
                await message({ type: "meeting-banner-ready" });
                break;
            case "dismiss":
                expect(
                    await message({ type: "meeting-banner-dismiss" }),
                ).toEqual({ ok: true });
                break;
            case "recording":
                await message(
                    {
                        type: "start-recording",
                        payload: {
                            tabId,
                            platformHint: "google-meet",
                            noticeAcknowledgedAt: "yes",
                        },
                    },
                    extension,
                );
                expect(h.session.recordingState.state).toBe("recording");
                break;
            case "microphone reminder":
            case "navigation":
                if (reason === "microphone reminder") {
                    navigator.permissions.query.mockResolvedValueOnce({
                        state: "denied",
                    });
                }
                h.tabs.set(tabId, { ...meeting, url: "https://example.com" });
                await h.listeners.updated(
                    tabId,
                    { url: "https://example.com" },
                    h.tabs.get(tabId),
                );
                break;
            case "tab close":
                h.tabs.delete(tabId);
                await h.listeners.tabRemoved(tabId);
                break;
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(chrome.action.setIcon).toHaveBeenLastCalledWith(normal);
        expectBadge(badge);
        const frames = chrome.action.setIcon.mock.calls.length;
        const badges = chrome.action.setBadgeText.mock.calls.length;
        await vi.advanceTimersByTimeAsync(25_000);
        expect(chrome.action.setIcon).toHaveBeenCalledTimes(frames);
        expect(chrome.action.setBadgeText).toHaveBeenCalledTimes(badges);
    });

    it("keeps REC when a highlighted badge write is in flight at recording start", async () => {
        vi.useFakeTimers();
        const highlightedWrite = Promise.withResolvers();
        const applied = [];
        let delayed = false;
        const setBadge = chrome.action.setBadgeText.getMockImplementation();
        chrome.action.setBadgeText.mockImplementation(async ({ text }) => {
            if (text === "" && !delayed) {
                delayed = true;
                await highlightedWrite.promise;
            }
            applied.push(text);
        });
        try {
            await arm();
            await vi.advanceTimersByTimeAsync(0);
            expect(delayed).toBe(true);
            const recording = message(
                {
                    type: "start-recording",
                    payload: {
                        tabId,
                        platformHint: "google-meet",
                        noticeAcknowledgedAt: "yes",
                    },
                },
                extension,
            );
            await vi.advanceTimersByTimeAsync(600);
            highlightedWrite.resolve();
            await recording;
            await vi.advanceTimersByTimeAsync(25_000);
            expect(h.session.recordingState.state).toBe("recording");
            expect(applied.at(-1)).toBe("REC");
            expect(applied.slice(applied.indexOf("REC"))).not.toContain("REC?");
        } finally {
            highlightedWrite.resolve();
            chrome.action.setBadgeText.mockImplementation(setBadge);
        }
    });

    it("skips unpinned prompts and re-syncs only visible prompts when pin state changes", async () => {
        chrome.action.getUserSettings.mockResolvedValue({ isOnToolbar: false });
        await arm();
        expect(chrome.action.setBadgeText.mock.calls).toEqual([
            [{ tabId, text: "REC?" }],
            [{ tabId, text: "REC?" }],
        ]);
        h.tabs.set(8, { ...meeting, id: 8, audible: false });
        await h.listeners.updated(8, { status: "complete" }, h.tabs.get(8));
        expect(chrome.action.setIcon).not.toHaveBeenCalled();
        chrome.tabs.sendMessage.mockClear();
        chrome.action.getUserSettings.mockResolvedValue({ isOnToolbar: true });
        h.listeners.pinChanged({ isOnToolbar: true });
        await vi.waitFor(() => expectBadge(""));
        expect(chrome.action.setIcon).toHaveBeenLastCalledWith(
            image("#f35f6d"),
        );
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            tabId,
            expect.objectContaining({ view: "prompt", pinned: true }),
            { frameId: 0 },
        );
        expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(
            8,
            expect.anything(),
            expect.anything(),
        );
        chrome.action.getUserSettings.mockResolvedValue({ isOnToolbar: false });
        h.listeners.pinChanged({ isOnToolbar: false });
        await vi.waitFor(() => expectBadge("REC?"));
        expect(chrome.action.setIcon).toHaveBeenLastCalledWith(normal);
        expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(
            tabId,
            expect.objectContaining({ view: "prompt", pinned: false }),
            { frameId: 0 },
        );
    });

    it("discards a prompt sync when navigation starts during the pin lookup", async () => {
        const lookupStarted = Promise.withResolvers();
        const pinSettings = Promise.withResolvers();
        chrome.action.getUserSettings.mockImplementationOnce(() => {
            lookupStarted.resolve();
            return pinSettings.promise;
        });
        const arming = arm();
        await lookupStarted.promise;
        await h.listeners.updated(tabId, { status: "loading" }, meeting);
        pinSettings.resolve({ isOnToolbar: true });
        await arming;

        expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
        expect(chrome.action.setIcon).not.toHaveBeenCalledWith(
            image("#f35f6d"),
        );
        expect(h.session.armedTabs[tabId].promptVisible).toBe(false);
    });

    it("ignores the old document's acknowledgement after navigation starts", async () => {
        const promptSent = Promise.withResolvers();
        const acknowledgement = Promise.withResolvers();
        chrome.tabs.sendMessage.mockImplementationOnce(() => {
            promptSent.resolve();
            return acknowledgement.promise;
        });
        const arming = arm();
        await promptSent.promise;
        await h.listeners.updated(tabId, { status: "loading" }, meeting);
        acknowledgement.resolve({ visible: true });
        await arming;

        expect(h.session.armedTabs[tabId].promptVisible).toBe(false);
        expect(chrome.action.setIcon).not.toHaveBeenCalledWith(
            image("#f35f6d"),
        );
    });

    it("re-renders an unpinned first prompt while the old render awaits acknowledgement", async () => {
        const promptSent = Promise.withResolvers();
        const acknowledgement = Promise.withResolvers();
        chrome.tabs.sendMessage.mockImplementationOnce((_tabId, payload) => {
            promptSent.resolve(payload);
            return acknowledgement.promise;
        });
        const arming = arm();
        const first = await promptSent.promise;
        const visibleBeforeAck = h.session.armedTabs[tabId].promptVisible;
        chrome.action.getUserSettings.mockResolvedValue({ isOnToolbar: false });
        h.listeners.pinChanged({ isOnToolbar: false });
        await settle();
        acknowledgement.resolve({ visible: true });
        await arming;

        expect(first).toMatchObject({ view: "prompt", pinned: true });
        expect(visibleBeforeAck).toBe(false);
        await vi.waitFor(() =>
            expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(
                tabId,
                expect.objectContaining({ view: "prompt", pinned: false }),
                { frameId: 0 },
            ),
        );
        expect(h.session.armedTabs[tabId].promptVisible).toBe(true);
        expect(chrome.action.setIcon).not.toHaveBeenCalledWith(
            image("#f35f6d"),
        );
    });

    it("sends no blink deadline when Chrome cannot build icon frames", async () => {
        vi.stubGlobal("OffscreenCanvas", undefined);
        await arm();
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            tabId,
            expect.objectContaining({
                view: "prompt",
                pinned: true,
                blinkUntil: null,
            }),
            { frameId: 0 },
        );
        expect(chrome.action.setIcon).not.toHaveBeenCalled();
    });

    it("clears the blink instructions when Chrome rejects an icon update", async () => {
        vi.useFakeTimers();
        const blinkUntil = Date.now() + 20_000;
        await arm();
        await vi.advanceTimersByTimeAsync(0);
        expectBadge("");
        chrome.action.setIcon.mockRejectedValueOnce(
            new Error("Could not update icon"),
        );
        await vi.advanceTimersByTimeAsync(600);
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            tabId,
            expect.objectContaining({ view: "prompt", blinkUntil }),
            { frameId: 0 },
        );
        expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(
            tabId,
            { type: "meeting-banner-blink-stopped", blinkUntil },
            { frameId: 0 },
        );
        expectBadge("REC?");
        const frames = chrome.action.setIcon.mock.calls.length;
        await vi.advanceTimersByTimeAsync(20_000);
        expect(chrome.action.setIcon).toHaveBeenCalledTimes(frames);
    });

    it("leaves a reserved blink unused when the worker restarts before the first frame", async () => {
        h.session.armedTabs = {
            7: { bannerPrompt: true, promptVisible: false },
        };
        const badge = { paintBadge: vi.fn(), restoreBadge: vi.fn() };
        const first = createPromptIconBlink(
            Promise.resolve({}),
            vi.fn(),
            badge,
        );
        expect(await first.reserve(tabId, () => true)).toBeTruthy();
        expect(h.session["prompt-icon:7"]).toEqual({
            until: expect.any(Number),
            used: false,
        });
        expect(chrome.action.setIcon).not.toHaveBeenCalled();

        const clearCopy = vi.fn();
        const restarted = createPromptIconBlink(
            Promise.resolve({ ...h.session }),
            clearCopy,
            badge,
        );
        const blink = await restarted.reserve(tabId, () => true);
        expect(blink).toBeTruthy();
        restarted.start(tabId, blink);
        await vi.waitFor(() =>
            expect(h.session["prompt-icon:7"]).toEqual({
                until: blink.until,
                used: true,
            }),
        );
        expect(chrome.action.setIcon).toHaveBeenLastCalledWith(
            image("#f35f6d"),
        );
        await restarted.stop(tabId);
    });

    it("restores interrupted overrides on a new worker and does not restart a visible prompt", async () => {
        const blinkUntil = Date.now() + 10_000;
        Object.assign(h.session, {
            "prompt-icon:7": blinkUntil,
            "prompt-icon:8": true,
            armedTabs: {
                7: { promptVisible: true },
                8: { promptVisible: false },
            },
        });
        const clearCopy = vi.fn(async () => {});
        await chrome.action.setBadgeText({ tabId, text: "" });
        const restored = createPromptIconBlink(
            Promise.resolve({ ...h.session }),
            clearCopy,
            {
                restoreBadge: (id) =>
                    chrome.action.setBadgeText({ tabId: id, text: "REC?" }),
            },
        );
        expect(await restored.reserve(tabId, () => true)).toBeNull();
        expect(chrome.action.setIcon).toHaveBeenCalledTimes(2);
        expect(chrome.action.setIcon).toHaveBeenCalledWith(normal);
        expect(chrome.action.setIcon).toHaveBeenCalledWith(
            expect.objectContaining({ tabId: 8, path: expect.any(Object) }),
        );
        expect(h.session["prompt-icon:8"]).toBeUndefined();
        expect(clearCopy).toHaveBeenCalledExactlyOnceWith(tabId, blinkUntil);
        expect(h.session["prompt-icon:7"]).toBe(blinkUntil);
        expect(chrome.action.setBadgeText).toHaveBeenCalledWith({
            tabId,
            text: "REC?",
        });
        await restored.stop(tabId);
    });
});

describe("meeting-site permission lifecycle", () => {
    it("registers a persistent isolated top-frame script and injects only matching open sites on grant", async () => {
        h.tabs.set(8, { id: 8, url: "https://other.example/" });
        h.listeners.added({ origins: MEETING_PROMPT_ORIGINS });
        await vi.waitFor(() =>
            expect(h.scripts.has(MEETING_PROMPT_SCRIPT_ID)).toBe(true),
        );
        expect(h.scripts.get(MEETING_PROMPT_SCRIPT_ID)).toMatchObject({
            matches: MEETING_PROMPT_ORIGINS,
            allFrames: false,
            persistAcrossSessions: true,
            world: "ISOLATED",
            js: [
                "popup/folder-combobox-shared.js",
                "lib/recording-levels.js",
                "content-meeting.js",
            ],
        });
        await vi.waitFor(() =>
            expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
                target: { tabId: 7, frameIds: [0] },
                files: [
                    "popup/folder-combobox-shared.js",
                    "lib/recording-levels.js",
                    "content-meeting.js",
                ],
            }),
        );
        expect(
            chrome.scripting.executeScript.mock.calls.some(
                ([input]) => input.target.tabId === 8,
            ),
        ).toBe(false);
        expect(h.local.meetingPromptOfferDismissed).toBe(true);
        h.listeners.added({ origins: MEETING_PROMPT_ORIGINS });
        await settle();
        expect(chrome.scripting.registerContentScripts).toHaveBeenCalledOnce();
        expect(chrome.scripting.updateContentScripts).toHaveBeenCalled();
    });
    it("unregisters, hides the open banner and restores the popup when access is removed", async () => {
        h.listeners.added({ origins: MEETING_PROMPT_ORIGINS });
        await vi.waitFor(() =>
            expect(h.session.armedTabs?.[7]?.promptVisible).toBe(true),
        );
        h.granted = false;
        h.listeners.removed({ origins: MEETING_PROMPT_ORIGINS });
        await vi.waitFor(() =>
            expect(h.scripts.has(MEETING_PROMPT_SCRIPT_ID)).toBe(false),
        );
        await vi.waitFor(() =>
            expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
                tabId: 7,
                popup: "popup/popup.html",
            }),
        );
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            { type: "meeting-banner", view: "hidden" },
            { frameId: 0 },
        );
    });
    it.each([
        "startup",
        "installed",
    ])("reconciles on %s without opening a window or tab", async (event) => {
        h.listeners[event]({ reason: "update" });
        await vi.waitFor(() =>
            expect(h.scripts.has(MEETING_PROMPT_SCRIPT_ID)).toBe(true),
        );
        await settle();
        expect(chrome.tabs.create).not.toHaveBeenCalled();
        expect(chrome.windows.create).not.toHaveBeenCalled();
    });
    it("keeps non-banner platforms on the notification path without expanding optional grants", async () => {
        h.local.platformModes = { jitsi: "prompt" };
        h.tabs.set(7, { ...meeting, url: "https://meet.jit.si/Aurora" });
        await arm();
        expect(chrome.notifications.create).toHaveBeenCalled();
        expect(MEETING_PROMPT_ORIGINS).toHaveLength(7);
        expect(
            MEETING_PROMPT_ORIGINS.some((pattern) =>
                /slack|jit\.si/.test(pattern),
            ),
        ).toBe(false);
    });
});

describe("meeting prompt and manual recording", () => {
    it("replaces the notification and keeps the popup after the card acknowledges visibility", async () => {
        await arm();
        expect(chrome.notifications.create).not.toHaveBeenCalled();
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({
                view: "prompt",
                shortcut: "Alt+Shift+R",
                notice: expect.any(String),
            }),
            { frameId: 0 },
        );
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "popup/popup.html",
        });
        expect(h.session.armedTabs[7].promptVisible).toBe(true);
    });
    it.each([
        "hidden",
        "missing",
        "error",
    ])("shows a notification fallback when the banner response is %s", async (result) => {
        if (result === "error")
            chrome.tabs.sendMessage.mockRejectedValueOnce(
                new Error("No receiver"),
            );
        else
            chrome.tabs.sendMessage.mockResolvedValueOnce(
                result === "hidden" ? { visible: false } : undefined,
            );
        await arm();
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "popup/popup.html",
        });
        expect(chrome.notifications.create).toHaveBeenCalledWith(
            "nudge:7",
            expect.anything(),
        );
        expect(h.session.armedTabs[7].promptVisible).toBe(false);
        chrome.notifications.clear.mockClear();
        expect(await message({ type: "meeting-banner-ready" })).toEqual({
            ok: true,
        });
        expect(chrome.notifications.clear).toHaveBeenCalledWith("nudge:7");
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "popup/popup.html",
        });
    });
    it("sends unpinned instructions and the actual assigned shortcut, omitting an empty shortcut", async () => {
        chrome.action.getUserSettings.mockResolvedValue({ isOnToolbar: false });
        chrome.commands.getAll.mockResolvedValue([
            { name: "toggle-recording", shortcut: "" },
        ]);
        await arm();
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({
                view: "prompt",
                pinned: false,
                shortcut: "",
            }),
            { frameId: 0 },
        );
    });
    it.each([
        "popup",
        "command",
    ])("starts tab capture from %s with an acknowledgement", async (invocation) => {
        await arm();
        if (invocation === "popup")
            expect(await startFromPopup()).toMatchObject({ ok: true });
        else await h.listeners.command("toggle-recording");
        await vi.waitFor(() =>
            expect(chrome.tabCapture.getMediaStreamId).toHaveBeenCalled(),
        );
        await settle();
        expect(h.createSession).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                noticeAcknowledgedAt: expect.any(String),
            }),
        );
        expect(h.session.recordingState.state).toBe("recording");
        expect(h.session.recordingState.autoStarted).toBe(false);
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "popup/popup.html",
        });
        chrome.alarms.create.mockClear();
        await h.listeners.updated(
            7,
            { audible: false },
            { ...h.tabs.get(7), audible: false },
        );
        expect(chrome.alarms.create).not.toHaveBeenCalled();
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({ view: "recording" }),
            { frameId: 0 },
        );
        expect(chrome.windows.create).not.toHaveBeenCalled();
        const payloads = JSON.stringify(chrome.tabs.sendMessage.mock.calls);
        expect(payloads).not.toContain("secret-capture-key");
        expect(payloads).not.toContain("private-recorder-token");
        expect(payloads).not.toContain("https://recorder.example");
    });
    it("dismisses for this meeting and keeps the popup without prompting again", async () => {
        await arm();
        expect(await message({ type: "meeting-banner-dismiss" })).toEqual({
            ok: true,
        });
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "popup/popup.html",
        });
        chrome.tabs.sendMessage.mockClear();
        await arm();
        expect(
            chrome.tabs.sendMessage.mock.calls.some(
                ([, payload]) => payload.view === "prompt",
            ),
        ).toBe(false);
    });
    it("hides and restores the popup on disarm, and prompts again for a different meeting", async () => {
        await arm();
        h.tabs.set(7, { ...meeting, url: "https://meet.google.com/" });
        await arm();
        expect(h.session.armedTabs[7]).toBeUndefined();
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "popup/popup.html",
        });
        h.tabs.set(7, {
            ...meeting,
            url: "https://meet.google.com/xyz-abcd-efg",
        });
        await arm();
        expect(h.session.armedTabs[7].promptVisible).toBe(true);
    });
    it("does not prompt for a muted tab or when nudges are disabled", async () => {
        h.tabs.get(7).audible = false;
        await arm();
        h.tabs.get(7).audible = true;
        h.local.nudgeEnabled = false;
        await arm();
        expect(
            chrome.tabs.sendMessage.mock.calls.some(
                ([, payload]) => payload.view === "prompt",
            ),
        ).toBe(false);
        expect(chrome.notifications.create).not.toHaveBeenCalled();
    });
    it("starts the existing desktop fallback from the popup with consent", async () => {
        await arm();
        expect(await startFromPopup({ forceDesktop: true })).toMatchObject({
            ok: true,
        });
        expect(chrome.windows.create).toHaveBeenCalledWith(
            expect.objectContaining({
                url: expect.stringContaining("picker/picker.html?requestId="),
            }),
        );
        expect(chrome.tabCapture.getMediaStreamId).not.toHaveBeenCalled();
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "popup/popup.html",
        });
        expect(
            Number.isFinite(
                Date.parse(h.session.recordingState.noticeAcknowledgedAt),
            ),
        ).toBe(true);
    });
    it("keeps the popup and shows the error if a popup start fails", async () => {
        h.createSession.mockRejectedValueOnce(
            new Error("Server refused capture"),
        );
        await arm();
        expect(await startFromPopup()).toMatchObject({ ok: false });
        await vi.waitFor(() =>
            expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
                7,
                expect.objectContaining({
                    view: "error",
                    state: expect.objectContaining({
                        error: "Server refused capture",
                    }),
                }),
                { frameId: 0 },
            ),
        );
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "popup/popup.html",
        });
    });
});

describe("meeting banner errors before capture starts", () => {
    it("shows a token-vault error from the keyboard shortcut and keeps the popup", async () => {
        await arm();
        h.readToken.mockRejectedValueOnce(
            new Error("Reconnect the recorder key"),
        );
        await h.listeners.command("toggle-recording");
        await vi.waitFor(() =>
            expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
                7,
                expect.objectContaining({
                    view: "error",
                    state: { error: "Reconnect the recorder key" },
                }),
                { frameId: 0 },
            ),
        );
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "popup/popup.html",
        });
        expect(chrome.windows.create).not.toHaveBeenCalled();
    });
});

describe("meeting banner senders and recording controls", () => {
    it.each([
        { id: "other" },
        { frameId: 1 },
        { tab: { id: 8 } },
        { url: "https://other.example/" },
        { url: "https://meet.google.com/xyz-abcd-efg" },
        { url: "https://meet.google.com/" },
    ])("rejects an invalid sender %j", async (override) => {
        await start();
        for (const type of [
            "get-folders",
            "set-recording-folder",
            "stop-recording",
            "meeting-banner-dismiss",
            "meeting-banner-ready",
        ]) {
            expect(
                await message(
                    {
                        type,
                        q: "Aurora",
                        sessionId: "session-1",
                        folderId: null,
                    },
                    { ...sender(), ...override },
                ),
            ).toMatchObject({ ok: false });
        }
        expect(h.search).not.toHaveBeenCalled();
    });
    it("allows folder search and writes only for the current recording tab and session", async () => {
        await start();
        expect(await message({ type: "get-folders", q: "Aurora" })).toEqual({
            ok: true,
            folders: [{ id: "new", label: "Private / Aurora" }],
        });
        expect(
            await message({
                type: "set-recording-folder",
                sessionId: "wrong",
                folderId: "new",
            }),
        ).toMatchObject({ ok: false, error: "folderChangeFailed" });
        expect(
            await message({
                type: "set-recording-folder",
                sessionId: "session-1",
                folderId: "new",
                folderLabel: "Private / Aurora",
            }),
        ).toEqual({ ok: true });
        expect(h.metas.get("session-1").folderId).toBe("new");
        expect(h.local.folderId).toBe("new");
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({
                view: "recording",
                state: expect.objectContaining({ folderId: "new" }),
            }),
            { frameId: 0 },
        );
    });
    it("rejects folder access when the server or the session lacks override support", async () => {
        await start();
        h.local.serverDefaults.recordingFolderOverride = false;
        expect(
            await message({ type: "get-folders", q: "Aurora" }),
        ).toMatchObject({ ok: false });
        expect(
            await message({
                type: "set-recording-folder",
                sessionId: "session-1",
                folderId: null,
            }),
        ).toMatchObject({ ok: false });
        h.local.serverDefaults.recordingFolderOverride = true;
        h.session.recordingState.recordingFolderOverride = false;
        expect(
            await message({
                type: "set-recording-folder",
                sessionId: "session-1",
                folderId: null,
            }),
        ).toMatchObject({ ok: false });
    });
    it("stops through the existing capture host and restores the popup when stopped", async () => {
        await start();
        expect(
            await message({ type: "stop-recording", sessionId: "wrong" }),
        ).toMatchObject({ ok: false });
        expect(
            await message({ type: "stop-recording", sessionId: "session-1" }),
        ).toEqual({ ok: true });
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            target: "offscreen",
            type: "stop",
            payload: undefined,
        });
        h.session.recordingState.stopped = true;
        expect(await message({ type: "meeting-banner-ready" })).toEqual({
            ok: true,
        });
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "popup/popup.html",
        });
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({ view: "stopped" }),
            { frameId: 0 },
        );
    });
    it("does not expose other internal messages or state to meeting content scripts", async () => {
        await arm();
        for (const type of [
            "get-state",
            "get-armed",
            "start-recording",
            "refresh-config",
            "capture-error",
            "levels",
            "discard-session",
        ]) {
            expect(await message({ type })).toMatchObject({
                ok: false,
                error: "unrecognizedSender",
            });
        }
        expect(await message({ type: "get-state" }, extension)).toHaveProperty(
            "state",
        );
    });
    it("rejects navigation and permission revocation even if the old script is still running", async () => {
        await start();
        const old = sender();
        h.tabs.set(7, { ...meeting, url: "https://other.example/" });
        expect(
            await message(
                { type: "stop-recording", sessionId: "session-1" },
                old,
            ),
        ).toMatchObject({ ok: false });
        h.tabs.set(7, { ...meeting });
        h.granted = false;
        expect(
            await message({ type: "get-folders", q: "Aurora" }, old),
        ).toMatchObject({ ok: false });
    });
});

describe("meeting prompt lifecycle boundaries", () => {
    it.each([
        false,
        true,
    ])("keeps auto mode's existing one-click consent with banner access=%s", async (granted) => {
        h.granted = granted;
        h.local.platformModes = { "google-meet": "auto" };
        h.local.autoModeAcknowledgedAt = "2026-10-20T12:00:00Z";
        await arm();
        expect(h.session.armedTabs[7].bannerPrompt).toBe(false);
        expect(h.session.armedTabs[7].promptVisible).toBe(false);
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "",
        });
        h.listeners.clicked(h.tabs.get(7));
        await vi.waitFor(() => expect(h.createSession).toHaveBeenCalled());
        await settle();
        expect(h.createSession.mock.calls[0][1].noticeAcknowledgedAt).toBe(
            h.local.autoModeAcknowledgedAt,
        );
        expect(h.session.recordingState.autoStarted).toBe(true);
        expect(chrome.action.setPopup).toHaveBeenLastCalledWith({
            tabId: 7,
            popup: "",
        });
        await h.listeners.updated(
            7,
            { audible: false },
            { ...h.tabs.get(7), audible: false },
        );
        expect(chrome.alarms.create).toHaveBeenCalledWith(
            "quiet:7",
            expect.anything(),
        );
    });
    it("hides a manually started pill on access removal even when the tab is not armed", async () => {
        h.local.platformModes = { "google-meet": "off" };
        expect(
            await message(
                {
                    type: "start-recording",
                    payload: {
                        tabId: 7,
                        noticeAcknowledgedAt: "2026-10-20T12:00:00Z",
                    },
                },
                extension,
            ),
        ).toMatchObject({ ok: true });
        expect(h.session.armedTabs?.[7]).toBeUndefined();
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({ view: "recording" }),
            { frameId: 0 },
        );
        chrome.tabs.sendMessage.mockClear();
        h.granted = false;
        h.listeners.removed({ origins: MEETING_PROMPT_ORIGINS });
        await vi.waitFor(() =>
            expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
                7,
                { type: "meeting-banner", view: "hidden" },
                { frameId: 0 },
            ),
        );
    });
});

describe("nudges while a different tab is recording", () => {
    it.each([
        false,
        true,
    ])("preserves the existing nudge trigger with banner access=%s", async (granted) => {
        h.granted = granted;
        h.session.recordingState = {
            state: "recording",
            sessionId: "other-session",
            tabId: 8,
        };
        await arm();
        if (granted)
            expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
                7,
                expect.objectContaining({ view: "prompt" }),
                { frameId: 0 },
            );
        else
            expect(chrome.notifications.create).toHaveBeenCalledWith(
                "nudge:7",
                expect.anything(),
            );
        expect(h.session.recordingState.sessionId).toBe("other-session");
    });
});

describe("fallback meeting notifications", () => {
    it("keeps the notification, appends the offer, and opens the options switch on body click", async () => {
        h.granted = false;
        await arm();
        expect(chrome.notifications.create).toHaveBeenCalledWith(
            "nudge:7",
            expect.objectContaining({
                message: "meetingRecordBody\nmeetingPromptNotificationHint",
            }),
        );
        await h.listeners.notificationClicked("nudge:7");
        expect(chrome.tabs.create).toHaveBeenCalledWith({
            url: "chrome-extension://test/options/options.html#meeting-prompt",
        });
        expect(chrome.windows.create).not.toHaveBeenCalled();
    });
});

describe("meeting banner review regressions", () => {
    it.each([
        "capture",
        "vault",
    ])("remembers dismissal of a %s error across tab updates, reevaluation and readiness", async (failure) => {
        await arm();
        const error = new Error("Aurora capture unavailable");
        if (failure === "capture") h.createSession.mockRejectedValueOnce(error);
        else h.readToken.mockRejectedValueOnce(error);
        await h.listeners.command("toggle-recording");
        await vi.waitFor(() =>
            expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
                7,
                expect.objectContaining({ view: "error" }),
                { frameId: 0 },
            ),
        );
        await settle();
        expect(await message({ type: "meeting-banner-dismiss" })).toEqual({
            ok: true,
        });
        expect(h.session.armedTabs[7].errorDismissed).toBe(true);
        chrome.tabs.sendMessage.mockClear();
        await arm();
        expect(await message({ type: "reevaluate-tabs" }, extension)).toEqual({
            ok: true,
        });
        expect(await message({ type: "meeting-banner-ready" })).toEqual({
            ok: true,
        });
        expect(
            chrome.tabs.sendMessage.mock.calls.some(
                ([, payload]) => payload.view === "error",
            ),
        ).toBe(false);
        expect(
            chrome.tabs.sendMessage.mock.calls.some(
                ([, payload]) => payload.view === "prompt",
            ),
        ).toBe(false);
    });
    it("remembers dismissal of an error from a manual start on an unarmed meeting tab", async () => {
        h.local.platformModes = { "google-meet": "off" };
        h.createSession.mockRejectedValueOnce(
            new Error("Aurora capture unavailable"),
        );
        expect(
            await message(
                {
                    type: "start-recording",
                    payload: {
                        tabId: 7,
                        noticeAcknowledgedAt: "2026-10-20T12:00:00Z",
                    },
                },
                extension,
            ),
        ).toMatchObject({ ok: false });
        expect(h.session.armedTabs?.[7]).toBeUndefined();
        expect(await message({ type: "meeting-banner-dismiss" })).toEqual({
            ok: true,
        });
        chrome.tabs.sendMessage.mockClear();
        expect(await message({ type: "meeting-banner-ready" })).toEqual({
            ok: true,
        });
        expect(
            chrome.tabs.sendMessage.mock.calls.some(
                ([, payload]) => payload.view === "error",
            ),
        ).toBe(false);
    });
    it("does not message or write session storage for an unarmed ordinary tab update", async () => {
        h.tabs.set(9, { id: 9, url: "https://news.example/" });
        await h.listeners.updated(9, { status: "complete" }, h.tabs.get(9));
        expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
        expect(chrome.storage.session.set).not.toHaveBeenCalled();
    });
    it.each([
        "prompt",
        "off",
    ])("hides the pill while preserving REC and the title after leaving a meeting with mode %s", async (mode) => {
        h.local.platformModes = { "google-meet": mode };
        if (mode === "prompt") await start();
        else
            await message(
                {
                    type: "start-recording",
                    payload: {
                        tabId: 7,
                        noticeAcknowledgedAt: "2026-10-20T12:00:00Z",
                    },
                },
                extension,
            );
        chrome.action.setBadgeText.mockClear();
        chrome.action.setTitle.mockClear();
        chrome.tabs.sendMessage.mockClear();
        h.tabs.set(7, { ...meeting, url: "https://news.example/" });
        await arm();
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            { type: "meeting-banner", view: "hidden" },
            { frameId: 0 },
        );
        expect(chrome.action.setBadgeText).not.toHaveBeenCalled();
        expect(chrome.action.setTitle).not.toHaveBeenCalled();
        expect(h.session.recordingState.state).toBe("recording");
        expect(h.session.recordingState.stopped).toBe(false);
    });
    it("re-arms meetings and resumes a pending upload when content-script registration throws", async () => {
        const error = new Error("Registration unavailable");
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        chrome.scripting.registerContentScripts.mockRejectedValueOnce(error);
        h.listLocalSessions.mockResolvedValueOnce(["buffer-aurora"]);
        h.listChunkIndices.mockResolvedValueOnce([0]);
        h.getSession.mockResolvedValueOnce({
            status: "open",
            received_chunks: [0],
        });
        h.metas.set("buffer-aurora", {
            serverUrl: "https://recorder.example",
            serverSessionId: "pending-aurora",
            nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
        });
        try {
            h.listeners.startup();
            await vi.waitFor(() =>
                expect(h.session.recordingState?.sessionId).toBe(
                    "pending-aurora",
                ),
            );
            await settle();
            expect(h.session.armedTabs[7].platformId).toBe("google-meet");
            expect(h.session.recordingState).toMatchObject({
                bufferId: "buffer-aurora",
                stopped: true,
                stopReason: "browser-closed",
            });
            expect(chrome.alarms.create).toHaveBeenCalledWith(
                "upload-retry",
                expect.objectContaining({ when: expect.any(Number) }),
            );
            expect(warning).toHaveBeenCalledWith(
                "[recorder] meeting prompt registration:",
                error,
            );
        } finally {
            warning.mockRestore();
        }
    });
    it("stores only sanitized meeting identities while waiting and recording", async () => {
        h.tabs.get(7).url += "?password=aurora-private#secret";
        await arm();
        expect(h.session.armedTabs[7].meetingTarget).toEqual(
            meetingTarget(h.tabs.get(7).url),
        );
        expect(await startFromPopup({ forceDesktop: true })).toMatchObject({
            ok: true,
        });
        expect(h.session.recordingState.meetingTarget).toEqual(
            meetingTarget(h.tabs.get(7).url),
        );
        delete h.session.recordingState;
        h.tabs.get(7).url =
            "https://meet.google.com/xyz-abcd-efg?password=aurora-private";
        await start();
        expect(h.session.recordingState.meetingTarget).toEqual(
            meetingTarget(h.tabs.get(7).url),
        );
        const writes = JSON.stringify(chrome.storage.session.set.mock.calls);
        expect(writes).not.toContain("password");
        expect(writes).not.toContain("aurora-private");
        expect(writes).not.toContain("meetingUrl");
    });
    it("accepts the same Teams meeting in the sender hash and rejects a different one", async () => {
        h.tabs.get(7).url =
            "https://teams.microsoft.com/v2/#/meetup-join/aurora-room?password=private";
        await start();
        const current = sender();
        expect(
            await message({ type: "get-folders", q: "Aurora" }, current),
        ).toMatchObject({ ok: true });
        expect(
            await message(
                { type: "get-folders", q: "Aurora" },
                {
                    ...current,
                    url: "https://teams.microsoft.com/v2/#/meetup-join/other-room",
                },
            ),
        ).toMatchObject({ ok: false });
        expect(h.session.recordingState.meetingTarget.meetingId).toBe(
            "aurora-room",
        );
    });
    it("tells auto-mode users that the icon opens Options until the policy is acknowledged", async () => {
        h.local.platformModes = { "google-meet": "auto" };
        await arm();
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({ view: "prompt", policyRequired: true }),
            { frameId: 0 },
        );
        h.listeners.clicked(h.tabs.get(7));
        await vi.waitFor(() =>
            expect(chrome.runtime.openOptionsPage).toHaveBeenCalled(),
        );
        expect(h.createSession).not.toHaveBeenCalled();
    });
});

describe("Chrome-check worker fixes", () => {
    it.each([
        [true, "before"],
        [true, "after"],
        [false, "before"],
        [false, "after"],
    ])("nudges with access=%s when audible arrives %s the armed entry is written", async (granted, order) => {
        h.granted = granted;
        h.tabs.get(7).audible = false;
        const snapshot = { ...h.tabs.get(7) };
        let release;
        let reached;
        const writeReached = new Promise((resolve) => {
            reached = resolve;
        });
        const writeGate = new Promise((resolve) => {
            release = resolve;
        });
        chrome.storage.session.set.mockImplementationOnce(async (patch) => {
            reached();
            await writeGate;
            Object.assign(h.session, patch);
        });
        const arming = h.listeners.updated(7, { status: "complete" }, snapshot);
        await writeReached;
        try {
            if (order === "after") {
                release();
                await arming;
                expect(h.session.armedTabs[7].nudged).toBe(false);
            }
            h.tabs.get(7).audible = true;
            await h.listeners.updated(
                7,
                { audible: true },
                { ...h.tabs.get(7) },
            );
        } finally {
            release();
            await arming;
        }
        expect(h.session.armedTabs[7].nudged).toBe(true);
        if (granted) {
            expect(h.session.armedTabs[7].promptVisible).toBe(true);
            expect(chrome.notifications.create).not.toHaveBeenCalled();
        } else {
            expect(chrome.notifications.create).toHaveBeenCalledOnce();
        }
    });
    it.each([
        ["https://meet.google.com/abc-defg-hij", "google-meet", 16],
        ["https://zoom.us/wc/12345/join", "zoom", 16],
        ["https://teams.microsoft.com/l/meetup-join/aurora", "teams", 64],
        ["https://teams.live.com/meet/aurora", "teams", 64],
        ["https://teams.cloud.microsoft/meet/aurora", "teams", 64],
        ["https://aurora.webex.com/meet/aurora", "webex", 16],
        ["https://whereby.com/aurora", "whereby", 16],
    ])("positions prompt and recording pill at the registry offset for %s", async (url, id, topOffset) => {
        h.tabs.get(7).url = url;
        h.local.platformModes = { [id]: "prompt" };
        await arm();
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({ view: "prompt", topOffset }),
            { frameId: 0 },
        );
        h.session.recordingState = {
            state: "recording",
            tabId: 7,
            sessionId: "aurora",
            meetingTarget: meetingTarget(url),
        };
        await message({ type: "meeting-banner-ready" });
        expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(
            7,
            expect.objectContaining({ view: "recording", topOffset }),
            { frameId: 0 },
        );
    });
    it("uses the banner title and a plain fallback when access exists, then focuses the meeting", async () => {
        h.visible = false;
        await arm();
        expect(chrome.notifications.create).toHaveBeenCalledWith(
            "nudge:7",
            expect.objectContaining({
                title: "meetingPromptTitle",
                message: "meetingRecordBody",
            }),
        );
        await h.listeners.notificationClicked("nudge:7");
        expect(chrome.tabs.create).not.toHaveBeenCalled();
        expect(chrome.tabs.update).toHaveBeenCalledWith(7, { active: true });
        expect(chrome.windows.update).toHaveBeenCalledWith(3, {
            focused: true,
        });
    });
    it.each([
        "missing",
        "closed",
    ])("ignores a notification body click when the meeting tab is %s", async (status) => {
        h.tabs.delete(7);
        if (status === "closed")
            chrome.tabs.get.mockRejectedValueOnce(
                new Error("No tab with id: 7"),
            );
        await h.listeners.notificationClicked("nudge:7");
        expect(chrome.tabs.create).not.toHaveBeenCalled();
        expect(chrome.tabs.update).not.toHaveBeenCalled();
        expect(chrome.windows.update).not.toHaveBeenCalled();
    });
});
