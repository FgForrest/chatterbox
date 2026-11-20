// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../extensions/recorder/popup/folder-combobox.js";

import "../../../extensions/recorder/lib/recording-levels.js";

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
    if (root?.host.isConnected) render("hidden");
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
        blinkUntil: pinned ? Date.now() + 20_000 : null,
        notice: "Inform participants before recording.",
    });
}

describe("in-meeting banner", () => {
    it.each([
        [
            "en",
            "Click the blinking Chatterbox icon in Chrome’s toolbar, then choose “Consent confirmed · Record this tab” in the popup.",
            "Click the Chatterbox icon with the REC? badge in Chrome’s toolbar, then choose “Consent confirmed · Record this tab” in the popup.",
        ],
        [
            "cs",
            "Klikněte na blikající ikonu Klepny na liště Chromu a v okně rozšíření zvolte „Souhlas potvrzen · Nahrávat tuto kartu“.",
            "Klikněte na ikonu Klepny se značkou REC? na liště Chromu a v okně rozšíření zvolte „Souhlas potvrzen · Nahrávat tuto kartu“.",
        ],
    ])("switches pinned instructions to the badge at the blink deadline in %s", (locale, blinking, badge) => {
        messages = locale === "cs" ? czechMessages : englishMessages;
        render("prompt", { pinned: true, blinkUntil: Date.now() + 20_000 });
        expect(el("how").textContent).toBe(blinking);
        vi.advanceTimersByTime(19_999);
        expect(el("how").textContent).toBe(blinking);
        vi.advanceTimersByTime(1);
        expect(el("how").textContent).toBe(badge);
    });

    it("uses the badge immediately with no active blink and clears the timer on hide or re-render", () => {
        render("prompt", { pinned: true, blinkUntil: null });
        expect(el("how").textContent).toBe(
            "Click the Chatterbox icon with the REC? badge in Chrome’s toolbar, then choose “Consent confirmed · Record this tab” in the popup.",
        );
        expect(vi.getTimerCount()).toBe(0);
        render("prompt", { pinned: true, blinkUntil: Date.now() + 1000 });
        expect(vi.getTimerCount()).toBe(1);
        render("prompt", { pinned: true, blinkUntil: Date.now() - 1 });
        expect(vi.getTimerCount()).toBe(0);
        expect(el("how").textContent).toContain("REC? badge");
        render("prompt", { pinned: true, blinkUntil: Date.now() + 1000 });
        render("hidden");
        expect(vi.getTimerCount()).toBe(0);
    });

    it("switches to the badge when the worker reports that this blink stopped early", () => {
        const blinkUntil = Date.now() + 20_000;
        render("prompt", { pinned: true, blinkUntil });
        const stop = (deadline) =>
            listener(
                { type: "meeting-banner-blink-stopped", blinkUntil: deadline },
                { id: "recorder-test" },
                vi.fn(),
            );
        stop(blinkUntil - 1);
        expect(el("how").textContent).toContain("blinking Chatterbox icon");
        stop(blinkUntil);
        expect(el("how").textContent).toContain("REC? badge");
        expect(vi.getTimerCount()).toBe(0);
        expect(root.host.isConnected).toBe(true);
    });

    it("mounts a labelled prompt in one closed shadow root without reading meeting content", () => {
        document.body.textContent = "Private meeting text";
        const readPage = vi.spyOn(document, "querySelectorAll");
        const readById = vi.spyOn(document, "getElementById");
        expect(prompt()).toHaveBeenCalledWith({
            visible: true,
            consentShown: true,
        });
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
        expect(el("how").textContent).toBe(
            "Click the blinking Chatterbox icon in Chrome’s toolbar, then choose “Consent confirmed · Record this tab” in the popup.",
        );
        expect(root.querySelector(".toolbar-icon").textContent).toBe("REC?");
        expect(root.querySelector(".prompt-detail").textContent).toContain(
            "confirm consent and start recording",
        );
        expect(root.querySelector("kbd").textContent).toBe("Ctrl+Shift+U");
        expect(
            [...root.querySelectorAll("button")].map((button) => button.id),
        ).toEqual(["close"]);
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
        expect(el("how").textContent).toContain("Extensions menu");
        const steps = root.querySelectorAll("ol li");
        expect(steps).toHaveLength(3);
        expect(steps[2].textContent).toContain(
            "Consent confirmed · Record this tab",
        );
        expect(steps[0].textContent).toBe(
            "Click the puzzle piece in Chrome’s toolbar.",
        );
        expect(steps[1].textContent).toContain("Click Chatterbox in the menu.");
        const menu = steps[1].querySelector(".toolbar-menu-row");
        expect(menu.querySelector("span").textContent).toBe("Chatterbox");
        expect(menu.querySelector("img")).toBeTruthy();
        expect(menu.querySelector("svg path")).toBeTruthy();
        expect(root.querySelector(".prompt-detail").textContent).toContain(
            "Use the pin next to Chatterbox",
        );
        expect(root.querySelector(".toolbar-badge")).toBeNull();
        expect(root.querySelector("kbd")).toBeNull();
    });
    it.each([
        true,
        false,
    ])("describes Options when policy is required (pinned=%s)", (pinned) => {
        render("prompt", {
            pinned,
            policyRequired: true,
            shortcut: "Alt+Shift+R",
            notice: "Custom reminder",
        });
        expect(el("how").textContent).toContain("Options");
        expect(el("how").textContent).toContain(
            "confirm the automatic recording policy",
        );
        expect(el("notice").textContent).toBe("Custom reminder");
        expect(root.querySelector("kbd")).toBeNull();
        expect(root.querySelector("section").textContent).not.toMatch(
            /starts at once/i,
        );
        expect(
            root.querySelector("ol li:last-child")?.firstChild.textContent,
        ).toBe(pinned ? undefined : "Click Chatterbox in the menu.");
    });
    it("shows the observed failure and recovery guidance without prompt actions", () => {
        render("prompt", {
            pinned: true,
            notice: "Inform participants",
            disconnected: true,
            connection: {
                message: "Cannot reach Chatterbox",
                detail: "No answer within 30 s",
            },
        });
        expect(el("meeting-connection").textContent).toContain(
            "No answer within 30 s",
        );
        expect(el("meeting-connection").textContent).toContain(
            "You can start recording when Chatterbox is reachable.",
        );
        expect(el("connection-retry")).toBeNull();
        expect(el("how")).toBeNull();
    });
    it.each(["close", "Escape"])("dismisses using %s", async (control) => {
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
    it("shows recording time and folder, and collapses and expands the pill", async () => {
        prompt();
        render("recording", { state });
        expect(el("recording-label").textContent).toBe(
            "Recording to Chatterbox",
        );
        expect(el("elapsed").textContent).toBe("04:12");
        await vi.advanceTimersByTimeAsync(1000);
        expect(el("elapsed").textContent).toBe("04:13");
        expect(el("folder-toggle").textContent).toBe("Planning");
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
            folderScope: null,
        });
        render("recording", {
            state: {
                ...state,
                folderId: "new",
                folderLabel: "Private / Aurora",
            },
        });
        expect(el("folder-toggle").textContent).toBe("Aurora");
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
        expect(el("how").textContent).toContain("Options");
        expect(el("how").textContent).toContain(
            "confirm the automatic recording policy",
        );
        expect(el("how").textContent).not.toContain("record this tab");
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
    ])("uses the toolbar illustration and updated prompt copy in %s", (locale) => {
        messages = locale === "cs" ? czechMessages : englishMessages;
        prompt();
        const mark = root.querySelector("img.logo");
        expect(mark.getAttribute("src")).toBe(
            `data:image/png;base64,${readFileSync("extensions/recorder/icons/icon-48.png").toString("base64")}`,
        );
        expect(el("how").textContent).toBe(
            locale === "cs"
                ? "Klikněte na blikající ikonu Klepny na liště Chromu a v okně rozšíření zvolte „Souhlas potvrzen · Nahrávat tuto kartu“."
                : "Click the blinking Chatterbox icon in Chrome’s toolbar, then choose “Consent confirmed · Record this tab” in the popup.",
        );
        expect(root.querySelector(".prompt-detail").textContent).toBe(
            locale === "cs"
                ? "Souhlas můžete potvrdit a nahrávání spustit také klávesovou zkratkou Ctrl+Shift+U."
                : "To confirm consent and start recording, you can also press Ctrl+Shift+U.",
        );
        expect(el("notice-label").textContent).toBe(
            locale === "cs"
                ? "Upozornění účastníkům:"
                : "Notice to participants:",
        );
        prompt(true, "");
        expect(root.querySelector(".prompt-detail")).toBeNull();
        expect(root.querySelector("kbd")).toBeNull();
        prompt(false, "Alt+Shift+R");
        expect(root.querySelector("kbd").textContent).toBe("Alt+Shift+R");
        expect(el("how").textContent).toBe(
            locale === "cs"
                ? "Otevřete rozšíření Klepna z nabídky rozšíření v Chromu."
                : "Open Chatterbox from Chrome’s Extensions menu.",
        );
        expect(el("notice").textContent).toContain("Inform participants");
        expect(root.querySelector("ol li:last-child").textContent).toContain(
            messages.recordTabWithConsent.message,
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
        expect(surface.children[2].textContent).toBe(messages.dismiss.message);
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
    ])("shows the last segment and retains the full folder title: %s", (folderLabel) => {
        render("recording", { state: { ...state, folderLabel } });
        expect(el("folder-toggle").textContent).toBe(
            folderLabel.split(/ › | \/ /).at(-1),
        );
        expect(el("folder-toggle").title).toContain(folderLabel);
    });
});

describe("in-page folder chip", () => {
    it.each([
        ["restricted", { restricted: true }, "folder-lock", "restricted"],
        ["released server", {}, "users", "organization"],
    ])("renders the %s target from folder lookup metadata", async (_label, marker, icon, color) => {
        send.mockImplementation(async (message) =>
            message.type === "get-folders"
                ? {
                      ok: true,
                      folders: [
                          {
                              id: "start",
                              label: "Organization / Planning",
                              scope: "org",
                              ...marker,
                          },
                      ],
                  }
                : { ok: true },
        );
        const recording = {
            ...state,
            folderLabel: "Organization / Planning",
            folderScope: "org",
        };
        render("recording", { state: recording });
        await vi.advanceTimersByTimeAsync(0);
        expect(send).toHaveBeenCalledWith({ type: "get-folders", id: "start" });
        expect(
            el("folder-toggle").querySelector(`.lucide-${icon}.text-${color}`),
        ).toBeTruthy();
        expect(el("folder-target").classList.contains(color)).toBe(true);
        expect(el("folder-toggle").textContent).toBe("Planning");
        expect(el("folder-toggle").title).toBe("Organization / Planning");
        if (!marker.restricted)
            expect(
                el("folder-toggle").querySelector(".lucide-folder-lock"),
            ).toBeNull();
        render("recording", { state: recording });
        expect(
            el("folder-toggle").querySelector(`.lucide-${icon}`),
        ).toBeTruthy();
        render("recording", { state: { ...recording, folderId: "ordinary" } });
        expect(
            el("folder-toggle").querySelector(".lucide-folder-lock"),
        ).toBeNull();
        expect(el("folder-target").classList.contains("restricted")).toBe(
            false,
        );
    });

    it("shows the restricted search result and keeps its marker on the selected target", async () => {
        const folder = {
            id: "restricted",
            label: "Organization / Pilot",
            scope: "org",
            restricted: true,
        };
        send.mockImplementation(async (message) =>
            message.type === "get-folders"
                ? {
                      ok: true,
                      folders:
                          message.q || message.id === folder.id ? [folder] : [],
                  }
                : { ok: true },
        );
        render("recording", { state });
        el("folder-toggle").click();
        const input = el("meeting-folder-picker");
        input.value = "Pilot";
        input.dispatchEvent(new Event("input"));
        await vi.advanceTimersByTimeAsync(200);
        const option = el("meeting-folder-listbox").children[1];
        expect(option.querySelector(".lucide-folder-lock")).toBeTruthy();
        option.click();
        await vi.advanceTimersByTimeAsync(0);
        render("recording", {
            state: {
                ...state,
                folderId: folder.id,
                folderLabel: folder.label,
                folderScope: folder.scope,
            },
        });
        expect(
            el("folder-toggle").querySelector(
                ".lucide-folder-lock.text-restricted",
            ),
        ).toBeTruthy();
        expect(el("pill-folder").hidden).toBe(true);
        render("recording", { state: { ...state, folderId: null } });
        expect(
            el("folder-toggle").querySelector(".lucide-folder-plus"),
        ).toBeTruthy();
        expect(el("folder-target").classList.contains("restricted")).toBe(
            false,
        );
    });

    it.each([
        true,
        false,
    ])("keeps focus on the reused toggle after remove (accepted=%s)", async (accepted) => {
        render("recording", { state });
        await vi.advanceTimersByTimeAsync(0);
        let finish;
        send.mockImplementation(async (message) =>
            message.type === "set-recording-folder"
                ? new Promise((resolve) => {
                      finish = resolve;
                  })
                : { ok: true },
        );
        el("folder-remove").focus();
        expect(root.activeElement).toBe(el("folder-remove"));
        el("folder-remove").click();
        expect(root.activeElement).toBe(el("folder-toggle"));
        await vi.advanceTimersByTimeAsync(0);
        if (accepted)
            render("recording", {
                state: { ...state, folderId: null, folderLabel: null },
            });
        finish(
            accepted ? { ok: true } : { ok: false, error: "Unfile refused" },
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(root.activeElement).toBe(el("folder-toggle"));
        expect(el("folder-toggle").textContent).toBe(
            accepted ? "Add to folder" : "Planning",
        );
        if (!accepted)
            expect(el("action-error").textContent).toBe("Unfile refused");
    });
    it.each([
        "en",
        "cs",
    ])("renders organization and private chips, unfiles and opens the empty action in %s", async (locale) => {
        messages = locale === "cs" ? czechMessages : englishMessages;
        render("recording", {
            state: {
                ...state,
                folderLabel: "Organization › Planning",
                folderScope: "org",
            },
        });
        expect(el("folder-toggle").textContent).toBe("Planning");
        expect(el("folder-toggle").title).toBe("Organization › Planning");
        expect(
            el("folder-toggle").querySelector(
                ".lucide-users.text-organization",
            ),
        ).toBeTruthy();
        expect(el("folder-target").classList.contains("organization")).toBe(
            true,
        );
        expect(el("folder-remove").getAttribute("aria-label")).toBe(
            locale === "cs" ? "Odstranit ze Planning" : "Remove from Planning",
        );
        await vi.advanceTimersByTimeAsync(0);
        send.mockClear();
        el("folder-remove").click();
        await vi.advanceTimersByTimeAsync(0);
        expect(send).toHaveBeenCalledWith({
            type: "set-recording-folder",
            sessionId: state.sessionId,
            folderId: null,
            folderLabel: null,
            folderScope: null,
        });
        render("recording", {
            state: {
                ...state,
                folderId: null,
                folderLabel: null,
                folderScope: null,
            },
        });
        expect(el("folder-toggle").textContent).toBe(
            locale === "cs" ? "Přidat do složky" : "Add to folder",
        );
        expect(
            el("folder-toggle").querySelector(".lucide-folder-plus"),
        ).toBeTruthy();
        expect(el("folder-target").classList.contains("folder-chip")).toBe(
            false,
        );
        expect(el("folder-remove").hidden).toBe(true);
        el("folder-toggle").click();
        expect(el("pill-folder").hidden).toBe(false);
        render("recording", { state });
        expect(
            el("folder-toggle").querySelector(".lucide-folder.text-primary"),
        ).toBeTruthy();
    });
    it("reports an unfile failure on the visible bar and retains the chip", async () => {
        render("recording", { state });
        await vi.advanceTimersByTimeAsync(0);
        send.mockResolvedValue({ ok: false, error: "Unfile refused" });
        el("folder-remove").click();
        await vi.advanceTimersByTimeAsync(0);
        expect(el("folder-toggle").textContent).toBe("Planning");
        expect(el("action-error").textContent).toBe("Unfile refused");
    });
    it("makes the old-server chip inert without a remove action and retains the hint", () => {
        render("recording", {
            state: { ...state, recordingFolderOverride: false },
        });
        expect(el("folder-remove").hidden).toBe(true);
        expect(el("folder-toggle").disabled).toBe(true);
        el("folder-toggle").click();
        expect(el("pill-folder").hidden).toBe(true);
        expect(el("folder-fixed").hidden).toBe(false);
        expect(el("folder-fixed").textContent).toBe(
            englishMessages.folderFixedAtStart.message,
        );
    });
});
