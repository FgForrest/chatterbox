// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const source = readFileSync("extensions/recorder/content-meeting.js", "utf8");
let root;
let listener;
let send;
beforeEach(() => {
    vi.useFakeTimers();
    const attach = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(
        function (options) {
            root = attach.call(this, options);
            return root;
        },
    );
    send = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("recorderFolders", {
        createRecordingFolder: () => ({
            render: vi.fn(),
            saved: async () => {},
        }),
    });
    vi.stubGlobal("chrome", {
        i18n: { getMessage: (key) => key, getUILanguage: () => "en" },
        runtime: {
            id: "test",
            sendMessage: send,
            onMessage: {
                addListener: (fn) => {
                    listener = fn;
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
    document.getElementById("recorder-meeting-banner")?.remove();
});
function render(view, payload = {}) {
    listener(
        { type: "meeting-banner", view, ...payload },
        { id: "test" },
        () => {},
    );
}
describe("agenda banner and pill", () => {
    it("offers matched agendas without reading page content and opens from the button gesture", () => {
        document.body.textContent = "Private meeting page";
        const readPage = vi.spyOn(document, "querySelectorAll");
        render("prompt", {
            notice: "Inform participants",
            agendas: [{ id: "one", title: "Acme review" }],
        });
        expect(root.querySelector(".agenda-line").textContent).toContain(
            "Acme review",
        );
        root.getElementById("agenda-show").click();
        expect(send).toHaveBeenLastCalledWith({ type: "open-agenda" });
        expect(readPage).not.toHaveBeenCalled();
    });
    it("adds an Agenda button to the recording pill and hides it without support", () => {
        const state = {
            sessionId: "session-one",
            startedAt: new Date().toISOString(),
            agendas: [{ id: "one" }],
        };
        render("recording", { state });
        expect(root.getElementById("pill-agenda").hidden).toBe(false);
        root.getElementById("pill-agenda").click();
        expect(send).toHaveBeenLastCalledWith({ type: "open-agenda" });
        render("recording", { state: { ...state, agendas: [] } });
        expect(root.getElementById("pill-agenda").hidden).toBe(true);
    });
    it("adds no agenda line on a released server", () => {
        render("prompt", { notice: "Inform participants" });
        expect(root.querySelector(".agenda-line")).toBeNull();
    });
});
