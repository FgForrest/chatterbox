// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { bindAgendaTextInput } from "@/lib/meetings/text-sync";
import { panelRoomHeartbeat } from "../../../extensions/recorder/lib/agenda-rooms.js";
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
let data;
let tab;
let controlOptions;
let session;
let settings;
let request;
let onChanges;
let matches;
let subscription;
let cards;
let disconnect;
let subscribe;
const el = (id) =>
    document.getElementById(id === "retry" ? "agenda-retry" : id);
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(async () => {
    vi.useFakeTimers();
    onChanges = [];
    subscription = undefined;
    disconnect = vi.fn();
    subscribe = vi.fn((_id, handlers) => {
        subscription = handlers;
        return disconnect;
    });
    document.documentElement.innerHTML = html;
    settings = { serverUrl: "https://recorder.example.com", supported: true };
    session = {
        [agendaPanelKey(7)]: { agendaIds: ["agenda-one"], tabId: 7 },
        recordingState: { state: "idle" },
    };
    tab = { id: 7, url: "https://meet.google.com/meet/abc-defg-hij" };
    data = {
        id: "agenda-one",
        meetingItemId: "meeting-one",
        title: "Acme review",
        permissions: { edit: true },
        plannedStart: "2026-10-27T09:00:00Z",
        plannedEnd: "2026-10-27T10:00:00Z",
        points: [
            {
                id: "p1",
                text: "Schedule",
                parentId: null,
                version: 2,
                discussedAt: null,
                note: null,
            },
            { id: "p2", text: "Release date", parentId: "p1", version: 0 },
        ],
        taskGroups: [
            {
                name: "Jitka Dvořáková",
                invited: true,
                tasks: [
                    {
                        id: "task-one",
                        text: "Prepare demo",
                        version: 3,
                        status: "open",
                        canEdit: false,
                        canClose: true,
                        note: "Assignee note",
                    },
                    {
                        id: "task-two",
                        text: "Review timeline",
                        version: 0,
                        status: "open",
                        canEdit: true,
                        canClose: false,
                    },
                ],
            },
            { name: "Other", invited: false, tasks: [] },
        ],
    };
    matches = vi.fn(async () => [
        { id: "agenda-one", title: "Acme review" },
        { id: "agenda-two", title: "Other review" },
    ]);
    request = vi.fn(async (_path, init) => {
        if (init) {
            const body = JSON.parse(init.body);
            if (init.method === "POST")
                data.points.push({
                    id: "p3",
                    text: body.text,
                    parentId: null,
                    version: 0,
                });
            if (init.method === "PATCH" && _path.includes("/points/")) {
                const point = data.points.find((row) =>
                    _path.endsWith(`/${row.id}`),
                );
                if ("discussed" in body)
                    point.discussedAt = body.discussed
                        ? new Date().toISOString()
                        : null;
                if ("note" in body) point.note = body.note;
                point.version += 1;
            }
            if (init.method === "PATCH" && _path.includes("/tasks/")) {
                const task = data.taskGroups
                    .flatMap((group) => group.tasks)
                    .find((row) => _path.endsWith(`/${row.id}`));
                task.status = body.status;
            }
        }
        return structuredClone(data);
    });
    vi.stubGlobal("chrome", {
        i18n: {
            getUILanguage: () => "en",
            getMessage: (key, values) => {
                let value = messages[key]?.message ?? key;
                for (const [i, item] of [values ?? ""].flat().entries())
                    value = value.replaceAll(`$${i + 1}`, item);
                return value;
            },
        },
        storage: {
            session: {
                get: vi.fn(async () => structuredClone(session)),
                set: vi.fn(async (patch) => {
                    Object.assign(session, patch);
                    for (const onChange of onChanges)
                        onChange(
                            Object.fromEntries(
                                Object.entries(patch).map(([key, newValue]) => [
                                    key,
                                    { newValue },
                                ]),
                            ),
                            "session",
                        );
                }),
            },
            onChanged: {
                addListener: (fn) => {
                    onChanges.push(fn);
                },
            },
        },
        runtime: { sendMessage: vi.fn(async () => ({ ok: true })) },
        tabs: { create: vi.fn(async () => {}) },
    });
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
});

async function start(doc = document, tabId = 7) {
    const run = new Function(
        "agendaPanelKey",
        "document",
        "location",
        "canChooseRecordingAgenda",
        "agendaRequest",
        "agendaChoices",
        "supportsAgendas",
        "localizeDocument",
        "t",
        "getSettings",
        "mountRecordingControls",
        "agendaFolder",
        "bindAgendaTextInput",
        "subscribeAgenda",
        "formatMeetingTime",
        "detectMeetingPlatform",
        "meetCode",
        "renderLinkedText",
        "panelRoomHeartbeat",
        "supportsAgendaRooms",
        "mountRoomCards",
        `return (async () => { ${source} })();`,
    );
    await run(
        agendaPanelKey,
        doc,
        {
            href: `chrome-extension://test/agenda/agenda.html${tabId == null ? "" : `?tab=${tabId}`}`,
        },
        canChooseRecordingAgenda,
        request,
        matches,
        (value) => value.supported,
        localizeDocument,
        t,
        async () => settings,
        async (_root, options) => {
            controlOptions = options;
            options.onTab(tab);
            return {
                folder: vi.fn(),
                destroy: vi.fn(),
                refreshMeeting: vi.fn(),
                refreshTab: vi.fn(),
            };
        },
        () => ({}),
        bindAgendaTextInput,
        subscribe,
        formatMeetingTime,
        detectMeetingPlatform,
        meetCode,
        renderLinkedText,
        panelRoomHeartbeat,
        (value) => value?.serverDefaults?.agendaRooms === 1,
        () => {
            cards = { render: vi.fn(), destroy: vi.fn() };
            return cards;
        },
    );
}

describe("#369 manual agenda panel choices", () => {
    it.each([
        [7, false, "en"],
        [7, true, "en"],
        [null, false, "en"],
        [null, true, "en"],
        [7, false, "cs"],
        [7, true, "cs"],
        [null, false, "cs"],
        [null, true, "cs"],
    ])("renders planned times and selects a missed agenda (tab %s, recording %s, %s)", async (tabId, recording, locale) => {
        vi.setSystemTime(new Date(2026, 10, 9, 12));
        const catalog = JSON.parse(
            readFileSync(
                `extensions/recorder/_locales/${locale}/messages.json`,
                "utf8",
            ),
        );
        chrome.i18n.getUILanguage = () => locale;
        chrome.i18n.getMessage = (key) => catalog[key]?.message ?? key;
        session[agendaPanelKey(tabId)] = { agendaIds: [data.id], tabId: 7 };
        if (recording)
            session.recordingState = {
                state: "recording",
                sessionId: "session-one",
                startedAt: new Date().toISOString(),
            };
        matches.mockResolvedValue([
            {
                id: "missed",
                title: "Acme review",
                state: "held",
                start: new Date(2026, 10, 8, 14).toISOString(),
                end: null,
            },
            {
                id: "today",
                title: "Acme review",
                start: new Date(2026, 10, 9, 10).toISOString(),
                end: new Date(2026, 10, 9, 11).toISOString(),
            },
            {
                id: "tomorrow",
                title: "Acme review",
                start: new Date(2026, 10, 10, 9).toISOString(),
                end: null,
            },
        ]);
        await start(document, tabId);
        el("change-agenda").click();
        await settle();
        expect(matches).toHaveBeenCalledExactlyOnceWith(
            Date.now(),
            [],
            expect.objectContaining({ onError: expect.any(Function) }),
        );
        const buttons = [
            ...el("choice-list").querySelectorAll("button:not(#none)"),
        ];
        expect(buttons.slice(-3).map((node) => node.textContent)).toEqual([
            `Acme review${catalog.agendaYesterday.message} 14:00`,
            `Acme review${catalog.agendaToday.message} 10:00–11:00`,
            `Acme review${catalog.agendaTomorrow.message} 09:00`,
        ]);
        buttons[buttons.length - 3].click();
        await settle();
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "select-agenda",
            agendaId: "missed",
            tabId: 7,
            sessionId: recording ? "session-one" : undefined,
        });
    });

    it.each([
        7,
        null,
    ])("passes requested agenda IDs to the picker before limiting choices (tab %s)", async (tabId) => {
        const agendaIds = ["agenda-one", "agenda-two"];
        session[agendaPanelKey(tabId)] = { agendaIds, tabId: 7 };
        await start(document, tabId);
        expect(matches).toHaveBeenCalledExactlyOnceWith(
            Date.now(),
            agendaIds,
            expect.objectContaining({ onError: expect.any(Function) }),
        );
        expect(
            [...el("choice-list").querySelectorAll("button:not(#none)")].map(
                (node) => node.textContent,
            ),
        ).toEqual(["Acme review", "Other review"]);
    });

    it("ignores choices received after a newer list has rendered", async () => {
        await start();
        let release;
        matches.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        el("change-agenda").click();
        await settle();
        matches.mockResolvedValueOnce([
            { id: "newer", title: "Newer choices" },
        ]);
        el("change-agenda").click();
        await settle();
        release([{ id: "stale", title: "Stale choices" }]);
        await settle();
        expect(el("choice-list").textContent).toContain("Newer choices");
        expect(el("choice-list").textContent).not.toContain("Stale choices");
    });

    it("shows the existing error and retry when both choice lookups fail", async () => {
        await start();
        matches.mockRejectedValueOnce(new Error("Both unavailable"));
        el("change-agenda").click();
        await settle();
        expect(el("status").textContent).toBe(messages.agendaLoadError.message);
        expect(el("retry").hidden).toBe(false);
    });

    it.each([
        "initial",
        "change",
    ])("keeps recording controls visible through %s chooser loading, failure, Retry and Cancel", async (entry) => {
        session.recordingState = {
            state: "recording",
            sessionId: "session-one",
        };
        if (entry === "initial")
            session[agendaPanelKey(7)] = {
                agendaIds: [],
                choose: true,
                tabId: 7,
            };
        let rejectChoices;
        matches.mockImplementationOnce(
            () =>
                new Promise((_resolve, reject) => {
                    rejectChoices = reject;
                }),
        );
        const opening = start();
        await settle();
        if (entry === "change") {
            await opening;
            el("change-agenda").click();
            await settle();
        }
        expect(el("choices").hidden).toBe(false);
        expect(el("recorder-controls").closest("[hidden]")).toBeNull();
        rejectChoices(new Error("Offline"));
        await opening;
        await settle();
        expect(el("agenda-error").hidden).toBe(false);
        expect(el("retry").closest("[hidden]")).toBeNull();
        expect(el("cancel-choice").closest("[hidden]")).toBeNull();
        expect(el("recorder-controls").closest("[hidden]")).toBeNull();
        el("retry").click();
        await settle();
        expect(matches).toHaveBeenCalledTimes(2);
        expect(el("agenda-error").hidden).toBe(true);
        expect(
            el("choice-list").querySelectorAll("button:not(#none)").length,
        ).toBeGreaterThan(0);
        expect(el("recorder-controls").closest("[hidden]")).toBeNull();
        el("cancel-choice").click();
        expect(el("choices").hidden).toBe(true);
        expect(el("recorder-controls").closest("[hidden]")).toBeNull();
        if (entry === "change") expect(el("agenda").hidden).toBe(false);
    });

    it("shows recording controls in a chooser and on errors while a colleague records", async () => {
        data.recordingBy = [{ name: "Acme colleague", self: false }];
        await start();
        expect(el("recorder-controls").hidden).toBe(false);
        matches.mockImplementationOnce(async (_now, _ids, { onError }) => {
            onError();
            return [];
        });
        el("change-agenda").click();
        await settle();
        expect(el("agenda-error").hidden).toBe(false);
        expect(el("recorder-controls").closest("[hidden]")).toBeNull();
        el("cancel-choice").click();
        request.mockRejectedValueOnce(new Error("Offline"));
        await vi.advanceTimersByTimeAsync(15000);
        expect(el("agenda-error").hidden).toBe(false);
        expect(el("recorder-controls").closest("[hidden]")).toBeNull();
    });
});

describe("agenda side panel", () => {
    it("counts top-level points and keeps parent and child ticks independent", async () => {
        data.points[0].discussedAt = "2026-10-27T09:00:00Z";
        data.points[1].discussedAt = "2026-10-27T09:00:00Z";
        data.points.push(
            { id: "p3", text: "Budget", parentId: null, version: 0 },
            { id: "p4", text: "Costs", parentId: "p3", version: 0 },
            { id: "p5", text: "Next steps", parentId: null, version: 0 },
        );
        await start();
        expect(el("point-count").textContent).toBe("Discussed 1 of 3");
        const checkboxes = () =>
            el("points").querySelectorAll('input[type="checkbox"]');
        checkboxes()[1].click();
        await settle();
        expect(el("point-count").textContent).toBe("Discussed 1 of 3");
        expect(checkboxes()[0].checked).toBe(true);
        checkboxes()[2].click();
        await settle();
        expect(el("point-count").textContent).toBe("Discussed 2 of 3");
        expect(checkboxes()[3].checked).toBe(false);
    });
    it("keeps two mounted tab panels on their own agendas for reads, edits and selection", async () => {
        const first = document.implementation.createHTMLDocument();
        const second = document.implementation.createHTMLDocument();
        first.documentElement.innerHTML = html;
        second.documentElement.innerHTML = html;
        const rows = {
            "agenda-one": structuredClone(data),
            "agenda-two": {
                ...structuredClone(data),
                id: "agenda-two",
                title: "Aurora planning",
            },
        };
        request.mockImplementation(async (path) =>
            structuredClone(rows[path.split("/")[1]]),
        );
        await start(first, 7);
        await chrome.storage.session.set({
            [agendaPanelKey(8)]: { agendaIds: ["agenda-two"], tabId: 8 },
        });
        await settle();
        await start(second, 8);
        expect(first.getElementById("title").textContent).toBe("Acme review");
        expect(second.getElementById("title").textContent).toBe(
            "Aurora planning",
        );
        for (const [doc, id] of [
            [first, "agenda-one"],
            [second, "agenda-two"],
        ]) {
            doc.querySelector("#points .link").click();
            const note = doc.querySelector(
                '#points textarea[data-field="point:p1:note"]',
            );
            note.value = `Note for ${id}`;
            note.dispatchEvent(new Event("change"));
            await settle();
            expect(request).toHaveBeenCalledWith(
                `/${id}/points/p1`,
                expect.objectContaining({
                    method: "PATCH",
                    body: JSON.stringify({
                        version: 2,
                        note: `Note for ${id}`,
                    }),
                }),
            );
            doc.querySelector("#tasks input[type=checkbox]").click();
            await settle();
            expect(request).toHaveBeenCalledWith(
                `/${id}/tasks/task-one`,
                expect.objectContaining({ method: "PATCH" }),
            );
        }
        request.mockClear();
        await chrome.storage.session.set({
            [agendaPanelKey(8)]: { agendaIds: ["agenda-two"], tabId: 8 },
        });
        await settle();
        expect(request.mock.calls.map(([path]) => path)).toEqual([
            "/agenda-two",
        ]);
        first.getElementById("change-agenda").click();
        await settle();
        first.querySelector("#choice-list button").click();
        await settle();
        expect(session[agendaPanelKey(7)]).toMatchObject({
            agendaIds: ["agenda-one"],
            tabId: 7,
        });
        expect(session[agendaPanelKey(8)]).toMatchObject({
            agendaIds: ["agenda-two"],
            tabId: 8,
        });
    });
    it("reads and listens only to the fallback window context without a tab query", async () => {
        session[agendaPanelKey()] = { agendaIds: ["agenda-one"] };
        await start(document, null);
        request.mockClear();
        await chrome.storage.session.set({
            [agendaPanelKey(7)]: { agendaIds: ["agenda-two"] },
        });
        await settle();
        expect(request).not.toHaveBeenCalled();
        await chrome.storage.session.set({
            [agendaPanelKey()]: { agendaIds: ["agenda-one"] },
        });
        await settle();
        expect(request).toHaveBeenCalledExactlyOnceWith("/agenda-one");
    });
    it("shows an away outline with nested points and task status icons", async () => {
        tab.url = "https://example.com";
        data.taskGroups[0].tasks[0].agendaNote = "Agenda note";
        await start();
        expect(el("title").textContent).toBe("Acme review");
        expect(el("points").children[1].style.marginInlineStart).toBe("26px");
        expect(el("tasks").textContent).toContain("Agenda note");
        expect(el("tasks").textContent).toContain("Not invited");
        expect(el("agenda").querySelectorAll("input")).toHaveLength(0);
        expect(el("tasks").querySelectorAll("svg")).toHaveLength(2);
        expect(el("away-hint").hidden).toBe(false);
    });
    it("saves discussed ticks and notes with each point's current version", async () => {
        await start();
        const check = el("points").querySelector('input[type="checkbox"]');
        check.click();
        await settle();
        expect(request).toHaveBeenCalledWith(
            "/agenda-one/points/p1",
            expect.objectContaining({
                method: "PATCH",
                body: JSON.stringify({ version: 2, discussed: true }),
            }),
        );
        el("points").querySelector(".link").click();
        const note = el("points").querySelector(
            'textarea[data-field="point:p1:note"]',
        );
        note.value = "Move to next week";
        note.dispatchEvent(new Event("change"));
        await settle();
        expect(request).toHaveBeenCalledWith(
            "/agenda-one/points/p1",
            expect.objectContaining({
                body: JSON.stringify({ version: 3, note: "Move to next week" }),
            }),
        );
        expect(
            el("points").querySelector('textarea[data-field="point:p1:note"]')
                .value,
        ).toBe("Move to next week");
    });
    it("uses done checkboxes with canClose, reopens done tasks and leaves dropped tasks read-only", async () => {
        data.taskGroups[0].tasks.push({
            id: "dropped",
            text: "Dropped task",
            status: "dropped",
            version: 1,
            canClose: true,
        });
        await start();
        const checks = () =>
            el("tasks").querySelectorAll("input[type=checkbox]");
        expect([...checks()].map((node) => node.disabled)).toEqual([
            false,
            true,
        ]);
        checks()[0].click();
        await settle();
        expect(request).toHaveBeenCalledWith(
            "/agenda-one/tasks/task-one",
            expect.objectContaining({
                body: JSON.stringify({ version: 3, status: "done" }),
            }),
        );
        expect(checks()[0].checked).toBe(true);
        checks()[0].click();
        await settle();
        expect(request).toHaveBeenCalledWith(
            "/agenda-one/tasks/task-one",
            expect.objectContaining({
                body: JSON.stringify({ version: 3, status: "open" }),
            }),
        );
        expect(el("tasks").querySelector(".dropped input")).toBeNull();
        expect(el("tasks").querySelector(".dropped svg")).not.toBeNull();
        expect(document.getElementById("quick-add")).toBeNull();
        expect(el("points").querySelectorAll("input[type=text]")).toHaveLength(
            0,
        );
    });
    it("explains a version conflict, rolls back and loads colleagues' changes", async () => {
        await start();
        request.mockRejectedValueOnce(
            Object.assign(new Error("changed"), { status: 409 }),
        );
        el("points").querySelector('input[type="checkbox"]').click();
        await settle();
        expect(el("status").textContent).toContain("Someone changed");
        expect(
            el("points").querySelector('input[type="checkbox"]').checked,
        ).toBe(false);
        data.points[0].text = "Updated schedule";
        await vi.advanceTimersByTimeAsync(15000);
        expect(el("points").textContent).toContain("Updated schedule");
    });
    it("shows recording state, switches to another agenda and can choose none", async () => {
        session.recordingState = {
            state: "recording",
            sessionId: "session-one",
            agendaId: "agenda-one",
            startedAt: new Date().toISOString(),
        };
        await start();
        expect(el("change-agenda").hidden).toBe(false);
        el("change-agenda").click();
        await settle();
        el("choice-list").querySelectorAll("button:not(#none)")[1].click();
        await settle();
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "select-agenda",
            agendaId: "agenda-two",
            sessionId: "session-one",
            tabId: 7,
        });
        el("change-agenda").click();
        await settle();
        el("none").click();
        await settle();
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "select-agenda",
            agendaId: null,
            sessionId: "session-one",
            tabId: 7,
        });
    });
    it("keeps absorbed agendas read-only", async () => {
        data.permissions.edit = false;
        await start();
        expect(document.getElementById("quick-add")).toBeNull();
        expect(
            [...el("points").querySelectorAll("input")].every(
                (node) => node.disabled,
            ),
        ).toBe(true);
        expect(el("tasks").querySelector("button")).toBeNull();
    });
    it.each([
        "en",
        "cs",
    ])("shows a successful unavailable-agenda completion without retry in %s", async (locale) => {
        const catalog = JSON.parse(
            readFileSync(
                `extensions/recorder/_locales/${locale}/messages.json`,
                "utf8",
            ),
        );
        chrome.i18n.getMessage = (key) => catalog[key]?.message ?? key;
        session.recordingState = {
            state: "completed",
            agendaUnavailable: true,
            stopped: true,
        };
        await start();
        expect(el("task-section").hidden).toBe(true);
        expect(el("recorder-controls").hidden).toBe(false);
        expect(el("agenda-error").hidden).toBe(true);
        expect(document.getElementById("attachment")).toBeNull();
    });
    it("shows unsupported status and makes no calls on a released server", async () => {
        settings.supported = false;
        await start();
        expect(el("agenda").hidden).toBe(true);
        expect(el("status").textContent).toContain(
            "does not support agendas yet",
        );
        expect(request).not.toHaveBeenCalled();
        expect(matches).not.toHaveBeenCalled();
    });
    it("hides private content after access is revoked", async () => {
        await start();
        request.mockRejectedValueOnce(
            Object.assign(new Error("forbidden"), { status: 403 }),
        );
        await vi.advanceTimersByTimeAsync(15000);
        expect(el("agenda").hidden).toBe(true);
        expect(document.getElementById("open-app")).toBeNull();
        expect(el("status").textContent).toContain("could not be loaded");
    });
    it("uses since and preserves the detail on an unchanged poll", async () => {
        data.version = 4;
        data.cursor = "4:standalone:idle";
        await start();
        request.mockResolvedValueOnce({
            unchanged: true,
            version: 4,
            cursor: data.cursor,
        });
        await vi.advanceTimersByTimeAsync(15000);
        expect(request).toHaveBeenLastCalledWith(
            "/agenda-one?since=4%3Astandalone%3Aidle",
        );
        expect(el("title").textContent).toBe("Acme review");
    });
    it("stops polling after the agenda is absorbed", async () => {
        data.recordingItemId = "recording-one";
        data.permissions.edit = false;
        await start();
        await vi.advanceTimersByTimeAsync(120000);
        expect(request).toHaveBeenCalledTimes(1);
    });
});

describe("live panel collaboration", () => {
    it("uses live invalidations with the last detail cursor and falls back to polling when down", async () => {
        settings.serverDefaults = { agendaLive: true };
        data.cursor = "4:standalone:idle";
        await start();
        expect(subscribe).toHaveBeenCalledTimes(1);
        subscription.onConnection(true);
        request.mockClear();
        await vi.advanceTimersByTimeAsync(15000);
        expect(request).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(45000);
        expect(request).toHaveBeenCalledTimes(1);
        await subscription.invalidate();
        expect(request).toHaveBeenLastCalledWith(
            "/agenda-one?since=4%3Astandalone%3Aidle",
        );
        subscription.onConnection(false);
        request.mockClear();
        await vi.advanceTimersByTimeAsync(15000);
        expect(request).toHaveBeenCalledTimes(1);
    });
    it("never starts streams or text requests without their independent flags", async () => {
        settings.serverDefaults = { agendas: true };
        data.textProtocol = 1;
        await start();
        el("points").querySelector(".link").click();
        const note = el("points").querySelector(
            'textarea[data-field="point:p1:note"]',
        );
        note.focus();
        note.value = "Legacy note";
        note.dispatchEvent(new Event("change"));
        await settle();
        expect(subscribe).not.toHaveBeenCalled();
        expect(
            request.mock.calls.some(([path]) => path.includes("/text")),
        ).toBe(false);
        expect(request).toHaveBeenCalledWith(
            "/agenda-one/points/p1",
            expect.objectContaining({ method: "PATCH" }),
        );
    });
    it("keeps the colleague notice inside complete controls and stays a live checklist during capture", async () => {
        data.recordingBy = [{ name: "Jitka Dvořáková", self: false }];
        await start();
        expect(el("recording-by").textContent).toContain("Jitka Dvořáková");
        expect(el("recorder-controls").hidden).toBe(false);
        expect(el("colleague-recording").hidden).toBe(false);
        expect(
            el("colleague-recording").closest("#recorder-controls"),
        ).not.toBeNull();
        expect(document.getElementById("record-also")).toBeNull();
        session.recordingState = {
            state: "recording",
            sessionId: "session-one",
            startedAt: new Date().toISOString(),
        };
        await chrome.storage.session.set({
            recordingState: session.recordingState,
        });
        await settle();
        expect(
            el("points").querySelector("input[type=checkbox]"),
        ).not.toBeNull();
        expect(document.getElementById("prep")).toBeNull();
    });
    it("links the edited agenda after a successful tick during recording", async () => {
        session.recordingState = {
            state: "recording",
            sessionId: "session-one",
            agendaId: null,
            startedAt: new Date().toISOString(),
        };
        await start();
        el("points").querySelector("input[type=checkbox]").click();
        await settle();
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "edit-agenda",
            agendaId: "agenda-one",
            sessionId: "session-one",
            tabId: 7,
        });
    });
    it("reuses the shared CRDT binding, keeps a focused textarea/caret, and flushes its materialized version before ticking", async () => {
        settings.serverDefaults = { agendaLive: true, agendaText: 1 };
        data.textProtocol = 1;
        data.cursor = "4:standalone:idle";
        const doc = new Y.Doc();
        const ytext = doc.getText("text");
        ytext.insert(0, "Initial");
        let materialized = 2;
        const base = request.getMockImplementation();
        const response = (field) => ({
            field,
            update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
            stateVector: Buffer.from(Y.encodeStateVector(doc)).toString(
                "base64",
            ),
            version: 9,
            materializedVersion: materialized,
        });
        request.mockImplementation(async (path, init) => {
            if (path.includes("/text?"))
                return response(
                    new URL(path, "https://example.com").searchParams.get(
                        "field",
                    ),
                );
            if (path.endsWith("/text") && init?.method === "POST") {
                const input = JSON.parse(init.body);
                Y.applyUpdate(doc, Buffer.from(input.update, "base64"));
                materialized++;
                data.points[0].note = ytext.toString();
                data.points[0].version = materialized;
                return response(input.field);
            }
            return base(path, init);
        });
        await start();
        el("points").querySelector(".link").click();
        const note = el("points").querySelector(
            'textarea[data-field="point:p1:note"]',
        );
        note.focus();
        await settle();
        expect(note.value).toBe("Initial");
        note.setSelectionRange(3, 3);
        ytext.insert(0, "Remote ");
        await subscription.invalidate();
        await settle();
        expect(
            el("points").querySelector('textarea[data-field="point:p1:note"]'),
        ).toBe(note);
        expect(document.activeElement).toBe(note);
        expect(note.value).toBe("Remote Initial");
        expect(note.selectionStart).toBe(10);
        const remote = ytext.toString();
        ytext.delete(0, ytext.length);
        data.points[0].note = "";
        await subscription.invalidate();
        await settle();
        expect(
            el("points").querySelector('textarea[data-field="point:p1:note"]'),
        ).toBe(note);
        expect(document.activeElement).toBe(note);
        expect(note.value).toBe("");
        ytext.insert(0, remote);
        data.points[0].note = remote;
        await subscription.invalidate();
        await settle();
        note.value += " local";
        note.dispatchEvent(new Event("input"));
        el("points").querySelector("input[type=checkbox]").click();
        await settle();
        const mutation = request.mock.calls.find(
            ([path, init]) =>
                path === "/agenda-one/points/p1" && init?.method === "PATCH",
        );
        expect(JSON.parse(mutation[1].body).version).toBe(3);
        expect(ytext.toString()).toBe("Remote Initial local");
        expect(
            request.mock.calls.findIndex(([path]) => path.endsWith("/text")),
        ).toBeLessThan(request.mock.calls.indexOf(mutation));
        doc.destroy();
    });
});

it.each([
    "cs",
    "en",
])("uses the extension UI language in the panel header: %s", async (locale) => {
    chrome.i18n.getUILanguage = () => locale;
    data.plannedStart = "2026-11-08T18:34:00Z";
    data.plannedEnd = "2026-11-08T19:17:00Z";
    await start();
    expect(el("time").textContent).toBe(
        locale === "cs" ? "8. 11. 18:34–19:17" : "11/8 18:34–19:17",
    );
});

it("reconciles an attached agenda even while its stream remains connected", async () => {
    settings.serverDefaults = { agendaLive: true };
    data.recordingItemId = "recording-one";
    data.cursor = "4:recording:idle";
    await start();
    subscription.onConnection(true);
    request.mockClear();
    await vi.advanceTimersByTimeAsync(59999);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledExactlyOnceWith(
        "/agenda-one?since=4%3Arecording%3Aidle",
    );
});

it("#386 changes from the away outline to a checklist and back without editing point titles", async () => {
    tab.url = "https://example.com";
    await start();
    expect(el("points").querySelector("input[type=checkbox]")).toBeNull();
    controlOptions.onTab({
        ...tab,
        url: "https://meet.google.com/meet/abc-defg-hij",
    });
    expect(el("points").querySelector("input[type=checkbox]")).not.toBeNull();
    expect(el("points").querySelector("input[type=text]")).toBeNull();
    expect(el("points").querySelector(".link").textContent).toBe("Note");
    controlOptions.onState({
        state: "recording",
        sessionId: "one",
        stopped: true,
        uploaded: [0],
        chunkCount: 2,
    });
    expect(el("points").querySelectorAll("input")).toHaveLength(0);
    expect(el("tasks").hidden).toBe(true);
    expect(el("task-count").textContent).toBe("Done 0 of 2");
});

it("#386 mounts recording controls even if the agenda detail fails, and Retry recovers it", async () => {
    request.mockRejectedValueOnce(new Error("offline"));
    await start();
    expect(controlOptions.variant).toBe("panel");
    expect(el("recorder-controls").hidden).toBe(false);
    expect(el("agenda-error").hidden).toBe(false);
    expect(el("status").textContent).toBe(messages.agendaLoadError.message);
    el("retry").click();
    await settle();
    expect(el("agenda-error").hidden).toBe(true);
    expect(el("agenda").hidden).toBe(false);
});

it("#386 shows non-empty point and task notes without a Note click", async () => {
    settings.serverDefaults = { agendaText: 1 };
    data.points[0].note = "Point note";
    data.taskGroups[0].tasks[0].agendaNote = "Task note";
    await start();
    const note = el("points").querySelector(
        'textarea[data-field="point:p1:note"]',
    );
    expect(note.value).toBe("Point note");
    expect(note.hidden).toBe(true);
    const preview = el("points").querySelector(".note-readonly");
    expect(preview.textContent).toBe("Point note");
    expect(preview.hidden).toBe(false);
    expect(el("tasks").querySelector(".note-readonly").textContent).toBe(
        "Task note",
    );
    expect(el("tasks").querySelector(".note-readonly").hidden).toBe(false);
});

it("shows a partial choice lookup failure without claiming there are no agendas", async () => {
    await start();
    matches.mockImplementationOnce(async (_now, _ids, { onError }) => {
        onError();
        return [];
    });
    el("change-agenda").click();
    await settle();
    expect(el("agenda-error").hidden).toBe(false);
    expect(el("choice-list").textContent).not.toContain(
        messages.agendaEmpty.message,
    );
});

it("keeps Cancel from reopening an initial empty chooser on the next poll", async () => {
    session[agendaPanelKey(7)] = { agendaIds: [], choose: true, tabId: 7 };
    await start();
    expect(el("choices").hidden).toBe(false);
    el("cancel-choice").click();
    expect(el("choices").hidden).toBe(true);
    expect(el("recorder-controls").hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(15000);
    expect(el("choices").hidden).toBe(true);
});

describe("#403 inline Agenda section", () => {
    it.each([
        false,
        true,
    ])("shows No agenda when nothing is chosen (explicit %s)", async (explicitNone) => {
        session[agendaPanelKey(7)] = { agendaIds: [], tabId: 7, explicitNone };
        await start();
        expect(el("title").textContent).toBe("No agenda");
        expect(el("title").tagName).toBe("H2");
        expect(el("no-agenda-hint").hidden).toBe(false);
        expect(el("change-agenda").textContent).toBe("Choose agenda");
        expect(el("choices").hidden).toBe(true);
        expect(el("recorder-controls").nextElementSibling).toBe(
            el("agenda-section"),
        );
        expect(el("agenda-section").contains(el("agenda-error"))).toBe(true);
        expect(matches).not.toHaveBeenCalled();
    });
    it.each([
        false,
        true,
    ])("marks No agenda Selected in the framed chooser (explicit %s)", async (explicitNone) => {
        session[agendaPanelKey(7)] = { agendaIds: [], tabId: 7, explicitNone };
        await start();
        el("change-agenda").click();
        await settle();
        expect(el("title").textContent).toBe("Choose agenda");
        expect(el("choice-list").lastElementChild).toBe(el("none"));
        expect(el("none").getAttribute("aria-checked")).toBe("true");
        expect(el("none").querySelector(".selected-label").textContent).toBe(
            "Selected",
        );
        expect(el("none").querySelector(".choice-radio")).not.toBeNull();
        el("none").click();
        await settle();
        expect(el("choices").hidden).toBe(true);
        expect(el("title").textContent).toBe("No agenda");
        expect(session[agendaPanelKey(7)].explicitNone).toBe(true);
    });
    it("keeps the current agenda selected and Cancel restores it without sending a choice", async () => {
        await start();
        el("change-agenda").click();
        await settle();
        expect(el("title").textContent).toBe("Change agenda");
        const selected = el("choice-list").querySelector(
            '[aria-checked="true"]',
        );
        expect(selected.textContent).toContain("Acme review");
        expect(selected.textContent).toContain("Selected");
        expect(el("none").getAttribute("aria-checked")).toBe("false");
        el("cancel-choice").click();
        expect(el("title").textContent).toBe("Acme review");
        expect(el("choices").hidden).toBe(true);
        expect(el("agenda").hidden).toBe(false);
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "select-agenda" }),
        );
        expect(chrome.storage.session.set).not.toHaveBeenCalled();
    });
    it("restores the recording's selected agenda when its chooser opens from the popup", async () => {
        session[agendaPanelKey(7)] = { agendaIds: [], tabId: 7, choose: true };
        session.recordingState = {
            state: "recording",
            sessionId: "session-one",
            tabId: 7,
            agendaId: "agenda-one",
        };
        await start();
        expect(el("title").textContent).toBe("Change agenda");
        expect(
            el("choice-list").querySelector('[aria-checked="true"]')
                .textContent,
        ).toContain("Acme review");
        expect(el("none").getAttribute("aria-checked")).toBe("false");
        el("cancel-choice").click();
        expect(el("title").textContent).toBe("Acme review");
        await chrome.storage.session.set({ recordingState: { state: "idle" } });
        await vi.advanceTimersByTimeAsync(15000);
        expect(el("title").textContent).toBe("Acme review");
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "select-agenda" }),
        );
    });
    it("hides tasks after Stop even when the agenda was already read-only", async () => {
        data.permissions.edit = false;
        await start();
        controlOptions.onState({
            state: "recording",
            sessionId: "session-one",
        });
        expect(el("task-section").hidden).toBe(false);
        controlOptions.onState({
            state: "recording",
            sessionId: "session-one",
            stopped: true,
        });
        expect(el("task-section").hidden).toBe(true);
        expect(el("after-hint").hidden).toBe(false);
        expect(el("points").querySelector(".status-icon")).not.toBeNull();
        controlOptions.onState({ state: "idle" });
        expect(el("task-section").hidden).toBe(false);
        expect(el("after-hint").hidden).toBe(true);
    });
    it("shows the empty window inside the list above No agenda", async () => {
        session[agendaPanelKey(7)] = { agendaIds: [], tabId: 7 };
        matches.mockResolvedValue([]);
        await start();
        el("change-agenda").click();
        await settle();
        expect(el("choice-list").firstElementChild.textContent).toBe(
            messages.agendaEmpty.message,
        );
        expect(el("choice-list").firstElementChild.nextElementSibling).toBe(
            el("none"),
        );
        expect(el("choice-list").textContent).toContain("24 hours");
        el("cancel-choice").click();
        expect(el("title").textContent).toBe("No agenda");
        expect(el("no-agenda-hint").hidden).toBe(false);
    });
    it("ignores a list arriving after Cancel", async () => {
        await start();
        let release;
        matches.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        el("change-agenda").click();
        await settle();
        el("cancel-choice").click();
        release([{ id: "late", title: "Late choice" }]);
        await settle();
        expect(el("title").textContent).toBe("Acme review");
        expect(el("choices").hidden).toBe(true);
        expect(el("choice-list").textContent).not.toContain("Late choice");
    });
    it("collapses immediately after selecting an agenda row without an Apply button", async () => {
        await start();
        el("change-agenda").click();
        await settle();
        el("choice-list").querySelector("button").click();
        await settle();
        expect(el("choices").hidden).toBe(true);
        expect(session[agendaPanelKey(7)]).toMatchObject({
            agendaIds: ["agenda-one"],
            choose: false,
            explicitNone: false,
        });
        expect(el("agenda").hidden).toBe(false);
        expect(el("cancel-choice").hidden).toBe(true);
    });
    it("keeps the presence notice visible while choosing and hides it during capture", async () => {
        data.recordingBy = [{ name: "Jitka Dvořáková", self: false }];
        await start();
        expect(controlOptions.idleNotice).toBe(el("colleague-recording"));
        el("change-agenda").click();
        await settle();
        expect(el("colleague-recording").hidden).toBe(false);
        expect(el("recorder-controls").hidden).toBe(false);
        controlOptions.onState({ state: "recording", sessionId: "one" });
        expect(el("colleague-recording").hidden).toBe(true);
    });
});

describe("#403 room states in the panel", () => {
    function enable() {
        settings.serverDefaults = { agendas: true, agendaRooms: 1 };
        settings.dataUseAcknowledgedAt = "now";
        settings.hasApiKey = true;
    }
    it("shows only the restricted heading when a room has no visible agenda", async () => {
        enable();
        session[agendaPanelKey(7)] = { tabId: 7, agendaIds: [], choose: false };
        chrome.runtime.sendMessage.mockImplementation(async (message) =>
            message.type === "room-agendas"
                ? { ok: true, data: [], restricted: true, invitations: [] }
                : { ok: true, retryAfterMs: 20000 },
        );
        await start();
        expect(el("title").textContent).toBe("Agenda is not shared with you");
        expect(el("no-agenda-hint").hidden).toBe(true);
        expect(el("recorder-controls").hidden).toBe(false);
        expect(request).not.toHaveBeenCalled();
        expect(cards.render).toHaveBeenLastCalledWith(
            expect.objectContaining({
                restricted: true,
                people: [],
                invitations: [],
            }),
        );
    });
    it("passes room invitations to the card without looking up the restricted agenda", async () => {
        enable();
        session[agendaPanelKey(7)] = { tabId: 7, agendaIds: [], choose: false };
        const invitation = {
            id: "share",
            agendaId: "hidden",
            title: "Acme planning",
            version: 0,
        };
        chrome.runtime.sendMessage.mockImplementation(async (message) =>
            message.type === "room-agendas"
                ? {
                      ok: true,
                      data: [],
                      restricted: true,
                      invitations: [invitation],
                  }
                : { ok: true, retryAfterMs: 20000 },
        );
        await start();
        expect(cards.render).toHaveBeenLastCalledWith(
            expect.objectContaining({ invitations: [invitation] }),
        );
        expect(request).not.toHaveBeenCalled();
        expect(el("title").hidden).toBe(true);
        expect(el("no-agenda-hint").hidden).toBe(true);
    });
    it("names a live room agenda's chooser and follows its automatic selection on polling", async () => {
        enable();
        data.own = false;
        session[agendaPanelKey(7)] = {
            tabId: 7,
            agendaIds: [],
            choose: false,
            roomAutomatic: true,
        };
        let id = "agenda-one";
        chrome.runtime.sendMessage.mockImplementation(async (message) =>
            message.type === "room-agendas"
                ? {
                      ok: true,
                      data: [
                          {
                              id,
                              chosenBy: [{ name: "Alex Rowan", self: false }],
                          },
                      ],
                      restricted: false,
                      invitations: [],
                  }
                : { ok: true, retryAfterMs: 20000 },
        );
        const base = request.getMockImplementation();
        request.mockImplementation((path, init) =>
            path.endsWith("/people")
                ? Promise.reject(
                      Object.assign(new Error("owner only"), { status: 404 }),
                  )
                : base(path, init),
        );
        await start();
        expect(el("room-chosen-by").textContent).toBe(
            "Chosen by Alex Rowan, who is recording this meeting",
        );
        id = data.id = "agenda-two";
        data.title = "Next planning";
        await vi.advanceTimersByTimeAsync(15000);
        expect(el("title").textContent).toBe("Next planning");
        expect(request).toHaveBeenCalledWith("/agenda-two");
    });
});

describe("#403 selection provenance", () => {
    function enable() {
        settings.serverDefaults = { agendas: true, agendaRooms: 1 };
        settings.dataUseAcknowledgedAt = "now";
        settings.hasApiKey = true;
    }
    it.each([
        { rows: [] },
        { rows: [{ id: "agenda-two" }] },
    ])("keeps an explicit Join selection when the room returns $rows", async ({
        rows,
    }) => {
        enable();
        session[agendaPanelKey(7)] = {
            tabId: 7,
            agendaIds: ["agenda-one"],
            agendaSource: "join",
            roomAutomatic: false,
        };
        chrome.runtime.sendMessage.mockImplementation(async (message) =>
            message.type === "room-agendas"
                ? { ok: true, data: rows, restricted: false, invitations: [] }
                : { ok: true, retryAfterMs: 20000 },
        );
        await start();
        await vi.advanceTimersByTimeAsync(60000);
        expect(controlOptions.agendaChoice()).toEqual({
            agendaId: "agenda-one",
        });
        expect(request).toHaveBeenCalledWith("/agenda-one");
        expect(request).not.toHaveBeenCalledWith("/agenda-two");
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "room-presence",
                agendaId: "agenda-one",
            }),
        );
    });
    it("keeps the current recording's agenda ahead of automatic room matching", async () => {
        enable();
        session[agendaPanelKey(7)] = {
            tabId: 7,
            agendaIds: ["agenda-two"],
            roomAutomatic: true,
            agendaSource: "automatic",
        };
        session.recordingState = {
            state: "recording",
            tabId: 7,
            sessionId: "capture",
            agendaId: "agenda-one",
        };
        chrome.runtime.sendMessage.mockImplementation(async (message) =>
            message.type === "room-agendas"
                ? {
                      ok: true,
                      data: [{ id: "agenda-two" }],
                      restricted: false,
                      invitations: [],
                  }
                : { ok: true, retryAfterMs: 20000 },
        );
        await start();
        expect(controlOptions.agendaChoice()).toEqual({
            agendaId: "agenda-one",
        });
        expect(request).not.toHaveBeenCalledWith("/agenda-two");
    });
    it("does not reuse stale detail as the selection when an automatic match opens the chooser", async () => {
        enable();
        session[agendaPanelKey(7)] = {
            tabId: 7,
            agendaIds: ["agenda-one"],
            roomAutomatic: true,
        };
        let rows = [{ id: "agenda-one" }];
        chrome.runtime.sendMessage.mockImplementation(async (message) =>
            message.type === "room-agendas"
                ? { ok: true, data: rows, restricted: false, invitations: [] }
                : { ok: true, retryAfterMs: 20000 },
        );
        await start();
        rows = [{ id: "agenda-one" }, { id: "agenda-two" }];
        await vi.advanceTimersByTimeAsync(15000);
        expect(el("choices").hidden).toBe(false);
        expect(el("none").getAttribute("aria-checked")).toBe("true");
        expect(controlOptions.agendaChoice()).toEqual({});
        expect(
            chrome.runtime.sendMessage.mock.calls
                .filter(([message]) => message.type === "room-presence")
                .every(([message]) => message.agendaId === null),
        ).toBe(true);
    });
    it("two panels follow A through throttled A+B matches to B without rebinding A beyond the presence TTL", async () => {
        enable();
        const recorder = document.implementation.createHTMLDocument("Recorder");
        recorder.documentElement.innerHTML = html;
        session[agendaPanelKey(7)] = {
            tabId: 7,
            agendaIds: ["agenda-one"],
            agendaSource: "panel",
        };
        session[agendaPanelKey(8)] = {
            tabId: 8,
            agendaIds: [],
            roomAutomatic: true,
            agendaSource: "automatic",
            choose: false,
        };
        let liveAgenda = "agenda-one";
        const presence = new Map();
        chrome.runtime.sendMessage.mockImplementation(async (message) => {
            if (message.type === "room-presence") {
                const previous = presence.get(message.tabId);
                const retryAfterMs = previous
                    ? 20000 - (Date.now() - previous.at)
                    : 0;
                if (retryAfterMs > 0) return { ok: true, retryAfterMs };
                presence.set(message.tabId, {
                    agendaId: message.agendaId,
                    at: Date.now(),
                });
                return { ok: true, retryAfterMs: 0 };
            }
            if (message.type === "select-agenda") liveAgenda = message.agendaId;
            if (message.type === "room-agendas") {
                const ids = new Set(
                    [
                        liveAgenda,
                        ...[...presence.values()]
                            .filter((row) => Date.now() - row.at < 180000)
                            .map((row) => row.agendaId),
                    ].filter(Boolean),
                );
                return {
                    ok: true,
                    data: [...ids].map((id) => ({ id })),
                    restricted: false,
                    invitations: [],
                };
            }
            return { ok: true };
        });
        request.mockImplementation(async (path) => ({
            ...structuredClone(data),
            id: path.split("/")[1],
            title: path.includes("agenda-two")
                ? "Next planning"
                : "Acme review",
        }));
        await start(recorder, 7);
        tab = { ...tab, id: 8 };
        await start(document, 8);
        expect(el("title").textContent).toBe("Acme review");
        expect(presence.get(8).agendaId).toBeNull();
        recorder.getElementById("change-agenda").click();
        await settle();
        const next = [...recorder.querySelectorAll(".agenda-option")].find(
            (node) => node.textContent.includes("Other review"),
        );
        next.click();
        await settle();
        expect(presence.get(7).agendaId).toBe("agenda-one");
        expect(liveAgenda).toBe("agenda-two");
        await vi.advanceTimersByTimeAsync(15000);
        expect(el("choices").hidden).toBe(false);
        expect(el("choice-list").textContent).toContain("Other review");
        expect(presence.get(7).agendaId).toBe("agenda-one");
        await vi.advanceTimersByTimeAsync(5000);
        expect(presence.get(7).agendaId).toBe("agenda-two");
        await vi.advanceTimersByTimeAsync(10000);
        expect(el("title").textContent).toBe("Next planning");
        expect(el("choices").hidden).toBe(true);
        for (const interval of [180000, 300000]) {
            await vi.advanceTimersByTimeAsync(interval);
            expect(el("title").textContent).toBe("Next planning");
            expect(el("choices").hidden).toBe(true);
            expect(presence.get(8).agendaId).toBeNull();
            expect(presence.get(7).agendaId).toBe("agenda-two");
        }
        expect(
            chrome.runtime.sendMessage.mock.calls
                .filter(
                    ([message]) =>
                        message.type === "room-presence" && message.tabId === 8,
                )
                .every(([message]) => message.agendaId === null),
        ).toBe(true);
    });
    it.each([
        false,
        true,
    ])("keeps reconciling an automatic chooser until a singleton matches (initial %s)", async (initial) => {
        enable();
        session[agendaPanelKey(7)] = {
            tabId: 7,
            agendaIds: initial ? ["agenda-one", "agenda-two"] : ["agenda-one"],
            choose: initial,
            roomAutomatic: true,
            agendaSource: "automatic",
        };
        let rows = initial
            ? [{ id: "agenda-one" }, { id: "agenda-two" }]
            : [{ id: "agenda-one" }];
        chrome.runtime.sendMessage.mockImplementation(async (message) =>
            message.type === "room-agendas"
                ? { ok: true, data: rows, restricted: false, invitations: [] }
                : { ok: true, retryAfterMs: 20000 },
        );
        request.mockImplementation(async (path) => ({
            ...structuredClone(data),
            id: path.split("/")[1],
            title: path.includes("agenda-two")
                ? "Next planning"
                : "Acme review",
        }));
        await start();
        rows = [{ id: "agenda-one" }, { id: "agenda-two" }];
        await vi.advanceTimersByTimeAsync(15000);
        expect(el("choices").hidden).toBe(false);
        rows = [{ id: "agenda-two" }];
        await vi.advanceTimersByTimeAsync(8 * 60000);
        expect(el("choices").hidden).toBe(true);
        expect(el("title").textContent).toBe("Next planning");
        expect(request).toHaveBeenCalledWith("/agenda-two");
        expect(
            chrome.runtime.sendMessage.mock.calls
                .filter(([message]) => message.type === "room-presence")
                .every(([message]) => message.agendaId === null),
        ).toBe(true);
    });
    it.each([
        "manual chooser",
        "explicit selection",
    ])("preserves a %s when automatic room matches change", async (mode) => {
        enable();
        session[agendaPanelKey(7)] = {
            tabId: 7,
            agendaIds: ["agenda-one"],
            roomAutomatic: true,
            agendaSource: "automatic",
        };
        let rows = [{ id: "agenda-one" }];
        chrome.runtime.sendMessage.mockImplementation(async (message) =>
            message.type === "room-agendas"
                ? { ok: true, data: rows, restricted: false, invitations: [] }
                : { ok: true, retryAfterMs: 20000 },
        );
        await start();
        el("change-agenda").click();
        await settle();
        if (mode === "explicit selection") {
            el("choice-list").querySelector("button").click();
            await settle();
        }
        rows = [{ id: "agenda-two" }];
        await vi.advanceTimersByTimeAsync(8 * 60000);
        expect(el("choices").hidden).toBe(mode === "explicit selection");
        expect(request).not.toHaveBeenCalledWith("/agenda-two");
        if (mode === "explicit selection")
            expect(el("title").textContent).toBe("Acme review");
    });
});
