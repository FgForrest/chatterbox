// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgendaCard } from "../../../extensions/recorder/lib/agenda-card.js";
import {
    agendaFolder,
    supportsAgendas,
} from "../../../extensions/recorder/lib/agendas.js";
import { STATE } from "../../../extensions/recorder/lib/constants.js";
import { localizeDocument, t } from "../../../extensions/recorder/lib/i18n.js";
import {
    createFolderField,
    createRecordingFolder,
} from "../../../extensions/recorder/popup/folder-combobox.js";

let listener;
let settings;
let save;
let send;
const agenda = {
    id: "agenda-one",
    title: "Acme review",
    folders: [{ id: "agenda-folder", name: "Acme" }],
};
const el = (id) => document.getElementById(id);
const settle = () => vi.advanceTimersByTimeAsync(0);

function load(page, dependencies) {
    document.documentElement.innerHTML = readFileSync(
        `extensions/recorder/${page}/${page}.html`,
        "utf8",
    );
    const source = readFileSync(
        `extensions/recorder/${page}/${page}.js`,
        "utf8",
    ).replace(/^import[\s\S]*?;\n/gm, "");
    new Function(...Object.keys(dependencies), source)(
        ...Object.values(dependencies),
    );
}

async function popup() {
    load("popup", {
        createAgendaCard,
        agendaFolder,
        supportsAgendas,
        STATE,
        localizeDocument,
        t,
        bindMeetingPromptOffer: () => async () => {},
        microphonePermission: async () => "granted",
        originOf: (url) => new URL(url).origin,
        detectMeetingPlatform: () => null,
        effectiveNoticeText: () => "Inform participants",
        effectivePlatformModes: () => ({}),
        getSettings: async () => settings,
        isPaired: async () => true,
        saveSettings: save,
        createFolderField,
        createRecordingFolder,
    });
    await settle();
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, "close").mockImplementation(() => {});
    settings = {
        serverUrl: "https://recorder.example.com",
        hasApiKey: true,
        dataUseAcknowledgedAt: "now",
        serverDefaults: { agendas: true },
        folderId: "private-default",
        folderLabel: "Private",
    };
    save = vi.fn(async (patch) => Object.assign(settings, patch));
    send = vi.fn(async (message) => {
        if (message.type === "get-state") return { state: { state: "idle" } };
        if (message.type === "match-agendas")
            return { ok: true, agendas: [agenda] };
        if (message.type === "get-folders")
            return {
                ok: true,
                folders: [{ id: "private-default", label: "Private" }],
            };
        return { ok: true };
    });
    vi.stubGlobal("chrome", {
        i18n: { getMessage: (key) => key, getUILanguage: () => "en" },
        runtime: {
            sendMessage: send,
            onMessage: {
                addListener: (fn) => {
                    listener = fn;
                },
            },
        },
        tabs: {
            query: vi.fn(async () => [
                { id: 7, windowId: 3, url: "https://example.com" },
            ]),
        },
        desktopCapture: { chooseDesktopMedia: vi.fn(() => 1) },
    });
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
});

describe("popup agenda confirmation", () => {
    it("previews the agenda folder without saving it, then sends the visible card on Record", async () => {
        await popup();
        expect(el("agenda-card").textContent).toContain("Acme review");
        expect(el("folder-picker").value).toContain("Acme");
        expect(settings.folderId).toBe("private-default");
        expect(
            save.mock.calls.every(
                ([patch]) => patch.folderId !== "agenda-folder",
            ),
        ).toBe(true);
        expect(
            send.mock.calls.every(
                ([message]) => message.type !== "select-agenda",
            ),
        ).toBe(true);
        el("start").click();
        await settle();
        expect(send).toHaveBeenCalledWith({
            type: "start-recording",
            payload: expect.objectContaining({ agendaId: "agenda-one" }),
        });
        expect(settings.folderId).toBe("private-default");
    });
    it("omits agendaId when Record is pressed before the match arrives", async () => {
        let release;
        const original = send.getMockImplementation();
        send.mockImplementation((message) =>
            message.type === "match-agendas"
                ? new Promise((resolve) => {
                      release = resolve;
                  })
                : original(message),
        );
        await popup();
        el("start").click();
        await settle();
        const start = send.mock.calls.find(
            ([message]) => message.type === "start-recording",
        )[0];
        expect(start.payload).not.toHaveProperty("agendaId");
        release({ ok: true, agendas: [agenda] });
        await settle();
        expect(
            send.mock.calls.every(
                ([message]) => message.type !== "select-agenda",
            ),
        ).toBe(true);
    });
});

describe.each(["en", "cs"])("localized agenda completion in %s", (locale) => {
    beforeEach(() => {
        const messages = JSON.parse(
            readFileSync(
                `extensions/recorder/_locales/${locale}/messages.json`,
                "utf8",
            ),
        );
        chrome.i18n.getMessage = (key) => messages[key]?.message ?? key;
    });
    it("shows the unavailable notice in the successful popup view without retry", async () => {
        await popup();
        listener({
            type: "state",
            state: { state: "completed", agendaUnavailable: true },
        });
        await settle();
        expect(el("view-completed").hidden).toBe(false);
        expect(el("completion-agenda-notice").textContent).toBe(
            t("agendaUnavailable"),
        );
        expect(el("view-error").hidden).toBe(true);
        listener({
            type: "state",
            state: { state: "completed", agendaUnavailable: false },
        });
        await settle();
        expect(el("completion-agenda-notice").textContent).toBe("");
    });
    it("shows the unavailable notice in the successful desktop recorder view", () => {
        load("picker", {
            createCaptureHost: () => ({}),
            openSystemAudio: vi.fn(),
            STATE,
            RECORDER_WINDOW_WIDTH: 360,
            fitWindowToContent: vi.fn(),
            localizeDocument,
            t,
            createRecordingFolder,
            location: {
                href: "chrome-extension://test/picker/picker.html?requestId=request-one",
            },
        });
        listener({
            type: "state",
            state: {
                state: "completed",
                pickerRequestId: "request-one",
                agendaUnavailable: true,
            },
        });
        expect(el("picker-completed").hidden).toBe(false);
        expect(el("picker-completion-agenda-notice").textContent).toBe(
            t("agendaUnavailable"),
        );
        expect(el("picker-controls").hidden).toBe(true);
    });
});
