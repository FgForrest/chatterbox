// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { bindAgendaTextInput } from "@/lib/meetings/text-sync";
import { createAgendaCard } from "../../../extensions/recorder/lib/agenda-card.js";
import {
    agendaPanelKey,
    canChooseRecordingAgenda,
} from "../../../extensions/recorder/lib/agendas.js";
import { localizeDocument, t } from "../../../extensions/recorder/lib/i18n.js";
import { renderLinkedText } from "../../../extensions/recorder/lib/linkify.js";
import { meetCode } from "../../../extensions/recorder/lib/meet-code.js";
import { formatMeetingTime } from "../../../extensions/recorder/lib/meeting-time.js";
import { detectMeetingPlatform } from "../../../extensions/recorder/lib/platforms.js";

const html = readFileSync("extensions/recorder/agenda/agenda.html", "utf8");
const source = readFileSync(
    "extensions/recorder/agenda/agenda.js",
    "utf8",
).replace(/^import[\s\S]*?;\n/gm, "");
const messages = JSON.parse(
    readFileSync("extensions/recorder/_locales/en/messages.json", "utf8"),
);
let detail;
let state;
let tab;
let settings;
let request;
let controls;
let subscription;
const changes = [];
const settle = () => vi.advanceTimersByTimeAsync(0);
const pointNote = () =>
    document.querySelector('#points textarea[data-field="point:p1:note"]');

beforeEach(() => {
    vi.useFakeTimers();
    changes.length = 0;
    document.documentElement.innerHTML = html;
    detail = {
        id: "agenda-one",
        title: "Acme review",
        version: 1,
        permissions: { edit: true },
        textProtocol: 1,
        points: [
            {
                id: "p1",
                text: "Read https://example.com/plan.",
                note: "Discuss www.example.com/notes.",
                parentId: null,
                version: 2,
            },
        ],
        taskGroups: [
            {
                name: "Acme",
                invited: true,
                tasks: [
                    {
                        id: "t1",
                        text: "Review http://example.org/task!",
                        agendaNote: "See https://example.org/task-note.",
                        version: 1,
                        status: "open",
                        canClose: true,
                    },
                ],
            },
        ],
    };
    state = { state: "idle" };
    tab = { id: 7, url: "https://meet.google.com/abc-defg-hij" };
    settings = { serverDefaults: { agendas: true } };
    request = vi.fn(async (_path, init) => {
        if (init?.method === "PATCH") {
            const body = JSON.parse(init.body);
            if ("note" in body) detail.points[0].note = body.note;
        }
        return structuredClone(detail);
    });
    vi.stubGlobal("chrome", {
        i18n: {
            getUILanguage: () => "en",
            getMessage: (key, values) => {
                let value = messages[key]?.message ?? key;
                for (const [i, part] of [values ?? ""].flat().entries())
                    value = value.replaceAll(`$${i + 1}`, part);
                return value;
            },
        },
        runtime: {
            sendMessage: vi.fn(async () => ({
                ok: true,
                agendas: [
                    { id: "agenda-one", title: "Read www.example.com/plan" },
                ],
            })),
        },
        storage: {
            session: {
                get: async () => ({
                    [agendaPanelKey(7)]: { agendaIds: [detail.id], tabId: 7 },
                    recordingState: state,
                }),
            },
            onChanged: { addListener: (fn) => changes.push(fn) },
        },
    });
});

afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

async function start() {
    const dependencies = {
        location: { href: "chrome-extension://test/agenda/agenda.html?tab=7" },
        agendaPanelKey,
        canChooseRecordingAgenda,
        agendaRequest: request,
        agendaChoices: async () => [],
        supportsAgendas: () => true,
        localizeDocument,
        t,
        getSettings: async () => settings,
        mountRecordingControls: async (_root, options) => {
            controls = options;
            options.onTab(tab);
            return { folder() {}, refreshMeeting() {}, destroy() {} };
        },
        agendaFolder: () => ({}),
        bindAgendaTextInput,
        subscribeAgenda: (_id, handlers) => {
            subscription = handlers;
            return () => {};
        },
        formatMeetingTime,
        detectMeetingPlatform,
        meetCode,
        renderLinkedText,
    };
    await new Function(
        ...Object.keys(dependencies),
        `return (async () => { ${source} })();`,
    )(...Object.values(dependencies));
}

describe("panel links and growing notes", () => {
    it.each([
        "away",
        "meeting",
        "recording",
    ])("renders all point/task links in the %s state", async (mode) => {
        if (mode === "away") tab.url = "https://example.com";
        if (mode === "recording")
            state = { state: "recording", sessionId: "session-one" };
        await start();
        for (const node of document.querySelectorAll("#points a, #tasks a"))
            expect(node.closest("[hidden]")).toBeNull();
        expect(
            [...document.querySelectorAll("#points a, #tasks a")].map(
                (node) => node.href,
            ),
        ).toEqual([
            "https://example.com/plan",
            "https://www.example.com/notes",
            "http://example.org/task",
            "https://example.org/task-note",
        ]);
        for (const node of document.querySelectorAll("#agenda a")) {
            expect(node.target).toBe("_blank");
            expect(node.rel).toBe("noopener noreferrer");
        }
        expect(detail.points[0].text).toBe("Read https://example.com/plan.");
    });

    it("shows linked point notes and a task count in the visible after-Stop summary", async () => {
        state = { state: "recording", sessionId: "session-one" };
        detail.points[0].discussedAt = new Date().toISOString();
        detail.taskGroups[0].tasks[0].status = "done";
        await start();
        controls.onState({ ...state, stopped: true });
        expect(document.querySelector("#agenda").hidden).toBe(false);
        expect(document.querySelector("#tasks").hidden).toBe(true);
        const count = document.querySelector("#task-count");
        expect(count.closest("[hidden]")).toBeNull();
        expect(count.textContent).toBe("Done 1 of 1");
        expect(document.querySelector("#point-count").textContent).toBe(
            "Discussed 1 of 1",
        );
        expect(
            document.querySelectorAll("#points input, #points textarea"),
        ).toHaveLength(0);
        const links = [...document.querySelectorAll("#agenda a")].filter(
            (node) => !node.closest("[hidden]"),
        );
        expect(links.map((node) => node.href)).toEqual([
            "https://example.com/plan",
            "https://www.example.com/notes",
        ]);
        for (const node of links) {
            expect(node.target).toBe("_blank");
            expect(node.rel).toBe("noopener noreferrer");
        }
    });

    it("does not tick a point or open a note editor when a link is clicked", async () => {
        await start();
        document.querySelector("#points .check-row a").click();
        document.querySelector("#points .note-readonly a").click();
        await settle();
        expect(document.querySelector("#points input").checked).toBe(false);
        expect(pointNote().hidden).toBe(true);
        expect(request.mock.calls.some(([, init]) => init)).toBe(false);
    });

    it("grows the textarea, normalizes pasted newlines and keeps Enter to save and blur", async () => {
        await start();
        const note = pointNote();
        expect(note.tagName).toBe("TEXTAREA");
        expect(note.rows).toBe(1);
        expect(note.wrap).toBe("soft");
        expect(note.hidden).toBe(true);
        document.querySelector("#points .note-editable").click();
        Object.defineProperties(note, {
            scrollHeight: { get: () => 90 },
            offsetHeight: { get: () => 32 },
            clientHeight: { get: () => 30 },
        });
        note.value = "First\nsecond\nhttps://example.com/notes";
        note.dispatchEvent(new Event("input"));
        expect(note.value).toBe("First second https://example.com/notes");
        expect(note.style.height).toBe("92px");
        const enter = new KeyboardEvent("keydown", {
            key: "Enter",
            cancelable: true,
        });
        note.dispatchEvent(enter);
        expect(enter.defaultPrevented).toBe(true);
        expect(document.activeElement).not.toBe(note);
        note.dispatchEvent(new Event("change"));
        await settle();
        expect(request).toHaveBeenCalledWith(
            "/agenda-one/points/p1",
            expect.objectContaining({
                body: JSON.stringify({
                    version: 2,
                    note: "First second https://example.com/notes",
                }),
            }),
        );
        expect(document.querySelector("#points .note-readonly a").href).toBe(
            "https://example.com/notes",
        );
    });

    it("leaves Enter to the input method during composition", async () => {
        await start();
        document.querySelector("#points .note-editable").click();
        const enter = new KeyboardEvent("keydown", {
            key: "Enter",
            isComposing: true,
            cancelable: true,
        });
        pointNote().dispatchEvent(enter);
        expect(enter.defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(pointNote());
    });

    it("opens a blank note from Note, and collapses it again on blur", async () => {
        detail.points[0].note = null;
        await start();
        document.querySelector("#points .link").click();
        expect(pointNote().hidden).toBe(false);
        pointNote().blur();
        await settle();
        expect(pointNote()).toBeNull();
        expect(document.querySelector("#points .link").textContent).toBe(
            "Note",
        );
    });

    it("supports keyboard editing and restores linked text when focus leaves", async () => {
        await start();
        const preview = document.querySelector("#points .note-editable");
        preview.focus();
        preview.dispatchEvent(
            new KeyboardEvent("keydown", {
                key: "Enter",
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(document.activeElement).toBe(pointNote());
        pointNote().blur();
        await settle();
        expect(pointNote().hidden).toBe(true);
        expect(preview.hidden).toBe(false);
    });

    it("preserves the shared CRDT binding, caret and normalized saves for point and task notes", async () => {
        settings.serverDefaults = {
            agendas: true,
            agendaText: 1,
            agendaLive: true,
        };
        const docs = new Map();
        for (const [field, value] of [
            ["point:p1:note", detail.points[0].note],
            ["task:t1:note", detail.taskGroups[0].tasks[0].agendaNote],
        ]) {
            const doc = new Y.Doc();
            doc.getText("text").insert(0, value);
            docs.set(field, doc);
        }
        const response = (field) => ({
            field,
            update: Buffer.from(
                Y.encodeStateAsUpdate(docs.get(field)),
            ).toString("base64"),
            stateVector: Buffer.from(
                Y.encodeStateVector(docs.get(field)),
            ).toString("base64"),
            version: 3,
            materializedVersion: 3,
        });
        const base = request.getMockImplementation();
        request.mockImplementation(async (path, init) => {
            if (path.includes("/text?"))
                return response(
                    new URL(path, "https://example.com").searchParams.get(
                        "field",
                    ),
                );
            if (path.endsWith("/text")) {
                const body = JSON.parse(init.body);
                Y.applyUpdate(
                    docs.get(body.field),
                    Buffer.from(body.update, "base64"),
                );
                return response(body.field);
            }
            return base(path, init);
        });
        state = { state: "recording", sessionId: "session-one" };
        await start();
        document.querySelector("#points .note-editable").click();
        await settle();
        const note = pointNote();
        note.setSelectionRange(3, 3);
        docs.get("point:p1:note").getText("text").insert(0, "Remote ");
        await subscription.invalidate();
        await settle();
        expect(pointNote()).toBe(note);
        expect(document.activeElement).toBe(note);
        expect(note.selectionStart).toBe(10);
        note.value += "\nlocal";
        note.dispatchEvent(new Event("input"));
        note.blur();
        await settle();
        expect(docs.get("point:p1:note").getText("text").toString()).toBe(
            "Remote Discuss www.example.com/notes. local",
        );
        document.querySelector("#tasks .note-editable").click();
        await settle();
        const taskNote = document.querySelector("#tasks textarea");
        taskNote.value += "\nfinished";
        taskNote.dispatchEvent(new Event("input"));
        taskNote.blur();
        await settle();
        expect(docs.get("task:t1:note").getText("text").toString()).toBe(
            "See https://example.org/task-note. finished",
        );
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "edit-agenda",
                agendaId: "agenda-one",
            }),
        );
        expect(document.querySelector("#tasks .note-readonly a").href).toBe(
            "https://example.org/task-note",
        );
        controls.onState({ state: "completed", stopped: true });
        for (const doc of docs.values()) doc.destroy();
    });

    it("updates an unfocused linked note after polling", async () => {
        await start();
        detail.points[0].note = "Changed https://example.net/new";
        await vi.advanceTimersByTimeAsync(15000);
        expect(document.querySelector("#points .note-readonly a").href).toBe(
            "https://example.net/new",
        );
        expect(pointNote().hidden).toBe(true);
    });

    it("keeps legacy drafts and focused carets across polls", async () => {
        await start();
        document.querySelector("#points .note-editable").click();
        const note = pointNote();
        note.value = "A draft";
        note.setSelectionRange(2, 2);
        request.mockClear();
        await vi.advanceTimersByTimeAsync(15000);
        expect(request).not.toHaveBeenCalled();
        expect(pointNote()).toBe(note);
        expect(note.value).toBe("A draft");
        expect(note.selectionStart).toBe(2);
    });

    it.each([
        false,
        true,
    ])("links agenda text in the popup card (recording %s)", async (recording) => {
        const root = document.createElement("section");
        const render = createAgendaCard(root, {
            tab: () => tab,
            onFolder: vi.fn(),
        });
        await render(
            {
                serverUrl: "https://example.com",
                hasApiKey: true,
                dataUseAcknowledgedAt: "2026-11-10",
                serverDefaults: { agendas: true },
            },
            recording
                ? {
                      state: "recording",
                      sessionId: "session-one",
                      agendaId: "agenda-one",
                      agendaTitle: "Read www.example.com/plan",
                  }
                : state,
        );
        expect(root.querySelector("strong a").href).toBe(
            "https://www.example.com/plan",
        );
    });
});
