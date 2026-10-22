// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../extensions/recorder/popup/folder-combobox.js";

const source = readFileSync("extensions/recorder/content-meeting.js", "utf8");
const englishMessages = JSON.parse(
    readFileSync("extensions/recorder/_locales/en/messages.json", "utf8"),
);
const czechMessages = JSON.parse(
    readFileSync("extensions/recorder/_locales/cs/messages.json", "utf8"),
);
let messages;
const state = {
    state: "recording",
    sessionId: "session-1",
    startedAt: "2026-10-22T12:00:00Z",
    folderId: "start",
    folderLabel: "Private / Planning",
    recordingFolderOverride: true,
};
let root;
let listener;
let send;

beforeEach(() => {
    messages = englishMessages;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T12:04:12Z"));
    delete globalThis.recorderMeetingBanner;
    const attach = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(
        function (options) {
            root = attach.call(this, options);
            return root;
        },
    );
    send = vi.fn(async (message) =>
        message.type === "get-folders"
            ? {
                  ok: true,
                  folders: message.q
                      ? [{ id: "new", label: "Private / Aurora" }]
                      : [],
              }
            : { ok: true },
    );
    vi.stubGlobal("chrome", {
        i18n: {
            getMessage: (key, substitutions) => {
                let value = messages[key]?.message ?? key;
                for (const [index, replacement] of [substitutions ?? ""]
                    .flat()
                    .entries())
                    value = value.replaceAll(`$${index + 1}`, replacement);
                return value;
            },
            getUILanguage: () => "en",
        },
        runtime: {
            id: "recorder-test",
            sendMessage: send,
            onMessage: {
                addListener: (callback) => {
                    listener = callback;
                },
            },
        },
    });
    new Function(source)();
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete globalThis.recorderMeetingBanner;
    document.body.replaceChildren();
    document.getElementById("recorder-meeting-banner")?.remove();
});
const el = (id) => root.getElementById(id);
function render(view, payload = {}) {
    const response = vi.fn();
    listener(
        { type: "meeting-banner", view, ...payload },
        { id: "recorder-test" },
        response,
    );
    return response;
}
function prompt(pinned = true, shortcut = "Ctrl+Shift+U") {
    return render("prompt", {
        pinned,
        shortcut,
        notice: "Inform participants before recording.",
    });
}

describe("in-meeting banner", () => {
    it("mounts a labelled prompt in one closed shadow root without reading meeting content", () => {
        document.body.textContent = "Private meeting text";
        const readPage = vi.spyOn(document, "querySelectorAll");
        const readById = vi.spyOn(document, "getElementById");
        expect(prompt()).toHaveBeenCalledWith({ visible: true });
        expect(readPage).not.toHaveBeenCalled();
        expect(readById).toHaveBeenCalledExactlyOnceWith(
            "recorder-meeting-banner",
        );
        const host = root.host;
        expect(host.shadowRoot).toBeNull();
        expect(
            root.querySelector('[role="dialog"]').getAttribute("aria-label"),
        ).toBe("Record this meeting with Chatterbox?");
        expect(el("notice").textContent).toBe(
            "Inform participants before recording.",
        );
        expect(el("consent").textContent).toContain("consent");
        expect(el("how").textContent).toContain("top right");
        expect(el("how").querySelector("kbd").textContent).toBe("Ctrl+Shift+U");
        expect(root.querySelector("style").textContent).toContain(
            "prefers-reduced-motion",
        );
        expect(root.querySelector("style").textContent).toContain(
            "prefers-color-scheme:dark",
        );
        expect(root.querySelector("style").textContent).toContain(
            ":focus-visible",
        );
    });
    it("explains the puzzle menu when unpinned and omits an unassigned shortcut", () => {
        prompt(false, "");
        expect(el("how").textContent).toContain("puzzle piece");
        expect(el("how").textContent).toContain("pin Chatterbox");
        expect(root.querySelector("kbd")).toBeNull();
    });
    it.each([
        "close",
        "not-now",
        "Escape",
    ])("dismisses using %s", async (control) => {
        prompt();
        if (control === "Escape")
            el("close").dispatchEvent(
                new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
            );
        else el(control).click();
        await vi.advanceTimersByTimeAsync(0);
        expect(send).toHaveBeenCalledWith({ type: "meeting-banner-dismiss" });
        expect(root.host.isConnected).toBe(false);
    });
    it("uses the dialog fallback without claiming the click invokes tab capture", async () => {
        prompt();
        el("dialog").click();
        await vi.advanceTimersByTimeAsync(0);
        expect(send).toHaveBeenCalledWith({ type: "meeting-banner-dialog" });
        expect(send).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "start-recording" }),
        );
    });
    it("shows recording time and folder, and collapses and expands the pill", async () => {
        prompt();
        render("recording", { state });
        expect(el("recording-label").textContent).toBe(
            "Recording to Chatterbox",
        );
        expect(el("elapsed").textContent).toBe("04:12");
        await vi.advanceTimersByTimeAsync(1000);
        expect(el("elapsed").textContent).toBe("04:13");
        expect(el("folder-toggle").textContent).toBe(
            `${state.folderLabel}\u200E`,
        );
        el("dot-toggle").click();
        expect(el("pill-details").hidden).toBe(true);
        expect(el("dot-toggle").getAttribute("aria-expanded")).toBe("false");
        el("dot-toggle").click();
        expect(el("pill-details").hidden).toBe(false);
    });
    it("uses the shared searchable combobox and changes the running recording's folder", async () => {
        render("recording", { state });
        el("folder-toggle").click();
        const input = el("meeting-folder-picker");
        expect(root.activeElement).toBe(input);
        input.value = "Aurora";
        input.dispatchEvent(new Event("input"));
        await vi.advanceTimersByTimeAsync(200);
        expect(send).toHaveBeenCalledWith({ type: "get-folders", q: "Aurora" });
        expect(el("meeting-folder-listbox").children[1].textContent).toBe(
            "Private / Aurora",
        );
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
        await vi.advanceTimersByTimeAsync(0);
        expect(send).toHaveBeenCalledWith({
            type: "set-recording-folder",
            sessionId: state.sessionId,
            folderId: "new",
            folderLabel: "Private / Aurora",
        });
        render("recording", {
            state: {
                ...state,
                folderId: "new",
                folderLabel: "Private / Aurora",
            },
        });
        expect(el("folder-toggle").textContent).toBe("Private / Aurora\u200E");
        expect(el("pill-folder").hidden).toBe(true);
        expect(el("folder-toggle").getAttribute("aria-expanded")).toBe("false");
        expect(root.activeElement).toBe(el("folder-toggle"));
    });
    it("restores the target and reports the existing error after a refused folder change", async () => {
        render("recording", { state });
        await vi.advanceTimersByTimeAsync(0);
        send.mockImplementation(async () => ({
            ok: false,
            error: "Could not change the target folder. Try again.",
        }));
        el("folder-toggle").click();
        el("meeting-folder-listbox").children[0].click();
        await vi.advanceTimersByTimeAsync(0);
        expect(el("meeting-folder-picker").value).toBe(
            `${state.folderLabel}\u200E`,
        );
        expect(el("meeting-folder-error").textContent).toBe(
            "Could not change the target folder. Try again.",
        );
        expect(el("meeting-folder-error").hidden).toBe(false);
        expect(el("pill-folder").hidden).toBe(false);
        expect(el("stop")).not.toBeNull();
    });
    it("keeps the start folder read-only on old servers without making folder requests", () => {
        render("recording", {
            state: { ...state, recordingFolderOverride: false },
        });
        el("folder-toggle").click();
        expect(el("meeting-folder-picker").readOnly).toBe(true);
        expect(el("meeting-folder-hint").textContent).toContain(
            "chosen at the start",
        );
        expect(
            send.mock.calls.filter(
                ([message]) => message.type === "get-folders",
            ),
        ).toHaveLength(0);
    });
    it("stops the existing session and briefly confirms without claiming upload completion", async () => {
        render("recording", { state });
        el("stop").click();
        await vi.advanceTimersByTimeAsync(0);
        expect(send).toHaveBeenCalledWith({
            type: "stop-recording",
            sessionId: state.sessionId,
        });
        render("stopped", { state: { ...state, stopped: true } });
        expect(root.textContent).toContain("Upload continues");
        await vi.advanceTimersByTimeAsync(2000);
        render("stopped", {
            state: { ...state, stopped: true, state: "finalizing" },
        });
        await vi.advanceTimersByTimeAsync(1500);
        expect(root.host.isConnected).toBe(false);
    });
    it("shows an existing recording error and removes all UI on disarm", () => {
        render("error", { state: { ...state, error: "Capture failed" } });
        expect(root.querySelector('[role="status"]').textContent).toBe(
            "Capture failed",
        );
        render("hidden");
        expect(root.host.isConnected).toBe(false);
    });
    it("ignores an old readiness refusal after a newer banner render", async () => {
        prompt();
        let finish;
        send.mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        globalThis.recorderMeetingBanner.refresh();
        prompt(false);
        finish({ ok: false });
        await vi.advanceTimersByTimeAsync(0);
        expect(root.host.isConnected).toBe(true);
    });
    it("hides the current UI when readiness validation is refused", async () => {
        prompt();
        send.mockResolvedValueOnce({ ok: false });
        globalThis.recorderMeetingBanner.refresh();
        await vi.advanceTimersByTimeAsync(0);
        expect(root.host.isConnected).toBe(false);
    });

    it("rejects messages from another sender and makes reinjection idempotent", () => {
        listener(
            { type: "meeting-banner", view: "prompt" },
            { id: "other" },
            vi.fn(),
        );
        expect(root.host.isConnected).toBe(false);
        new Function(source)();
        expect(Element.prototype.attachShadow).toHaveBeenCalledOnce();
        expect(
            send.mock.calls.filter(
                ([message]) => message.type === "meeting-banner-ready",
            ),
        ).toHaveLength(2);
    });
});

describe("meeting banner DOM and lifecycle review fixes", () => {
    it.each([
        "button",
        "Escape",
    ])("sends error dismissal to the worker through %s", async (control) => {
        render("error", { state: { error: "Aurora capture failed" } });
        const close = root.querySelector("button");
        if (control === "button") close.click();
        else
            close.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
            );
        await vi.advanceTimersByTimeAsync(0);
        expect(send).toHaveBeenCalledWith({ type: "meeting-banner-dismiss" });
        expect(root.host.isConnected).toBe(false);
    });
    it("ignores a DOM element clobbering the old global guard", () => {
        delete globalThis.recorderMeetingBanner;
        const clobber = document.createElement("div");
        clobber.id = "recorderMeetingBanner";
        document.body.append(clobber);
        globalThis.recorderMeetingBanner = clobber;
        expect(() => new Function(source)()).not.toThrow();
        expect(typeof globalThis.recorderMeetingBanner.refresh).toBe(
            "function",
        );
        prompt();
        expect(root.host.isConnected).toBe(true);
    });
    it("ignores untrusted pageshow events", () => {
        send.mockClear();
        window.dispatchEvent(new Event("pageshow"));
        expect(send).not.toHaveBeenCalled();
    });
    it("replaces an orphaned banner host before mounting", () => {
        const stale = document.createElement("div");
        stale.id = "recorder-meeting-banner";
        document.documentElement.append(stale);
        prompt();
        expect(stale.isConnected).toBe(false);
        expect(
            document.querySelectorAll("#recorder-meeting-banner"),
        ).toHaveLength(1);
        expect(root.host.isConnected).toBe(true);
    });
    it("removes its own host without messaging after the extension context is invalidated", () => {
        prompt();
        delete chrome.runtime.id;
        send.mockClear();
        globalThis.recorderMeetingBanner.refresh();
        expect(root.host.isConnected).toBe(false);
        expect(send).not.toHaveBeenCalled();
    });
    it("updates folder-toggle accessibility state when Escape closes the list", () => {
        render("recording", { state });
        el("folder-toggle").click();
        expect(el("folder-toggle").getAttribute("aria-expanded")).toBe("true");
        el("meeting-folder-picker").dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
        expect(el("folder-toggle").getAttribute("aria-expanded")).toBe("false");
        expect(el("pill-folder").hidden).toBe(true);
    });
    it.each([
        true,
        false,
    ])("explains policy acknowledgement before automatic recording when pinned=%s", (pinned) => {
        render("prompt", {
            pinned,
            shortcut: "Ctrl+Shift+U",
            policyRequired: true,
            notice: "Inform participants.",
        });
        expect(el("how").textContent).toContain("open Options");
        expect(el("how").textContent).toContain(
            "confirm your automatic recording policy",
        );
        expect(el("how").textContent).not.toContain("record this tab");
        expect(el("consent").textContent).toContain("Sharing through Chrome");
        expect(root.querySelector("kbd")).toBeNull();
    });
    it("builds the prompt, recording controls and folder picker with Trusted Types HTML sinks blocked", () => {
        vi.spyOn(Element.prototype, "innerHTML", "set").mockImplementation(
            () => {
                throw new TypeError("TrustedHTML required");
            },
        );
        expect(() => prompt()).not.toThrow();
        expect(el("title").textContent).toContain("Record this meeting");
        expect(() => render("recording", { state })).not.toThrow();
        el("folder-toggle").click();
        expect(el("meeting-folder-picker").getAttribute("role")).toBe(
            "combobox",
        );
        expect(el("meeting-folder-label").textContent).toBe(
            "Target folder in Chatterbox",
        );
    });
});

describe("Chrome-check banner fixes", () => {
    it.each([
        "en",
        "cs",
    ])("uses the popup mark, notice label, emphasized icon and shortcut sentence in %s", (locale) => {
        messages = locale === "cs" ? czechMessages : englishMessages;
        prompt();
        const mark = root.querySelector("img.logo");
        expect(mark.getAttribute("src")).toBe(
            `data:image/png;base64,${readFileSync("extensions/recorder/icons/icon-48.png").toString("base64")}`,
        );
        expect(el("how").querySelector("strong").textContent).toBe(
            locale === "cs" ? "ikonu Klepny" : "the Chatterbox icon",
        );
        expect(el("how").textContent).toBe(
            locale === "cs"
                ? "Klikněte na ikonu Klepny vpravo nahoře, nebo stiskněte Ctrl+Shift+U. Nahraje se tato karta, bez dalšího dialogu."
                : "Click the Chatterbox icon at the top right, or press Ctrl+Shift+U. This tab will be recorded, without another dialog.",
        );
        expect(el("notice-label").textContent).toBe(
            locale === "cs"
                ? "Upozornění účastníkům:"
                : "Notice to participants:",
        );
        expect(el("consent").textContent).toBe(
            locale === "cs"
                ? "Kliknutím na ikonu potvrzujete, že souhlas máte."
                : "Clicking the icon confirms you have consent.",
        );
        prompt(true, "");
        expect(el("how").textContent).toBe(
            locale === "cs"
                ? "Klikněte na ikonu Klepny vpravo nahoře. Nahraje se tato karta, bez dalšího dialogu."
                : "Click the Chatterbox icon at the top right. This tab will be recorded, without another dialog.",
        );
        expect(el("how").querySelector("kbd")).toBeNull();
        prompt(false, "Alt+Shift+R");
        expect(el("how").querySelector("kbd").textContent).toBe("Alt+Shift+R");
        expect(el("notice").textContent).toContain("Inform participants");
        expect(el("consent").textContent).toContain(
            locale === "cs" ? "souhlas" : "consent",
        );
    });
    it.each([
        "en",
        "cs",
    ])("identifies the product before the server error in %s", (locale) => {
        messages = locale === "cs" ? czechMessages : englishMessages;
        render("error", { state: { error: "Aurora server unavailable" } });
        const surface = root.querySelector("section");
        expect(surface.children[0].textContent).toBe(
            locale === "cs"
                ? "Klepna: nahrávání se nespustilo"
                : "Chatterbox: recording did not start",
        );
        expect(surface.getAttribute("aria-label")).toBe(
            surface.children[0].textContent,
        );
        expect(surface.children[1].textContent).toBe(
            "Aurora server unavailable",
        );
        expect(surface.children[2].textContent).toBe(
            messages.meetingPromptDismiss.message,
        );
    });
    it("keeps composed typed events out of the page's bubble listeners while preserving folder search", async () => {
        render("recording", { state });
        el("folder-toggle").click();
        const bubble = vi.fn();
        const capture = vi.fn();
        const types = ["keydown", "keypress", "beforeinput", "input", "keyup"];
        for (const type of types) {
            document.addEventListener(type, bubble);
            document.addEventListener(type, capture, true);
        }
        try {
            const input = el("meeting-folder-picker");
            input.value = "aur";
            for (const type of types) {
                input.dispatchEvent(
                    type.includes("input")
                        ? new InputEvent(type, {
                              data: "r",
                              bubbles: true,
                              composed: true,
                          })
                        : new KeyboardEvent(type, {
                              key: "r",
                              bubbles: true,
                              composed: true,
                          }),
                );
            }
            expect(bubble).not.toHaveBeenCalled();
            expect(capture.mock.calls.map(([event]) => event.type)).toEqual(
                types,
            );
            await vi.advanceTimersByTimeAsync(200);
            expect(send).toHaveBeenCalledWith({
                type: "get-folders",
                q: "aur",
            });
        } finally {
            for (const type of types) {
                document.removeEventListener(type, bubble);
                document.removeEventListener(type, capture, true);
            }
        }
    });
    it.each([
        16, 64,
    ])("applies the platform's %i px offset to both prompt and pill", (topOffset) => {
        render("prompt", {
            pinned: true,
            notice: "Inform participants.",
            topOffset,
        });
        expect(root.host.style.top).toBe(`${topOffset}px`);
        expect(root.host.style.getPropertyPriority("top")).toBe("important");
        render("recording", { state, topOffset });
        expect(root.host.style.top).toBe(`${topOffset}px`);
    });
    it.each([
        [0, "00:00"],
        [3599, "59:59"],
        [3600, "1:00:00"],
        [3852, "1:04:12"],
    ])("formats %i elapsed seconds as %s", (seconds, expected) => {
        vi.setSystemTime(
            new Date(Date.parse(state.startedAt) + seconds * 1000),
        );
        render("recording", { state });
        expect(el("elapsed").textContent).toBe(expected);
    });
    it("hides the two-character hint only while a searchable query is typed", () => {
        render("recording", { state });
        el("folder-toggle").click();
        const input = el("meeting-folder-picker");
        const hint = el("meeting-folder-hint");
        expect(hint.hidden).toBe(false);
        for (const [value, hidden] of [
            ["a", false],
            ["au", true],
            ["aur", true],
            [" a ", false],
            ["", false],
        ]) {
            input.value = value;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            expect(hint.hidden).toBe(hidden);
        }
    });
    it("waits for a successful pick before closing and does not close on a remembered-folder refresh", async () => {
        let finish;
        send.mockImplementation(async (message) => {
            if (message.type === "get-folders")
                return {
                    ok: true,
                    folders: [{ id: "start", label: "Private / Renamed" }],
                };
            if (
                message.type === "set-recording-folder" &&
                message.folderId === null
            )
                return new Promise((resolve) => {
                    finish = resolve;
                });
            return { ok: true };
        });
        render("recording", { state });
        el("folder-toggle").click();
        await vi.advanceTimersByTimeAsync(0);
        expect(el("pill-folder").hidden).toBe(false);
        el("meeting-folder-listbox").children[0].click();
        await vi.advanceTimersByTimeAsync(0);
        expect(el("pill-folder").hidden).toBe(false);
        finish({ ok: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(el("pill-folder").hidden).toBe(true);
        expect(root.activeElement).toBe(el("folder-toggle"));
    });
    it.each([
        "Private / Aurora / Weekly planning",
        "مشروعات / أورورا / اجتماعات",
    ])("retains the full folder path and LRM for truncation: %s", (folderLabel) => {
        render("recording", { state: { ...state, folderLabel } });
        expect(el("folder-toggle").textContent).toBe(`${folderLabel}\u200E`);
        expect(el("folder-toggle").title).toContain(folderLabel);
    });
});
