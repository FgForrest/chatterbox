// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { bindAgendaTextInput } from "@/lib/meetings/text-sync";
import {
    agendaPanelKey,
    canChooseRecordingAgenda,
} from "../../../extensions/recorder/lib/agendas.js";
import { localizeDocument, t } from "../../../extensions/recorder/lib/i18n.js";
import { formatMeetingTime } from "../../../extensions/recorder/lib/meeting-time.js";

const html = readFileSync("extensions/recorder/agenda/agenda.html", "utf8");
const source = readFileSync(
    "extensions/recorder/agenda/agenda.js",
    "utf8",
).replace(/^import[\s\S]*?;\n/gm, "");
const messages = JSON.parse(
    readFileSync("extensions/recorder/_locales/en/messages.json", "utf8"),
);
let data;
let session;
let settings;
let request;
let onChanges;
let matches;
let subscription;
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
        "matchAgendas",
        "supportsAgendas",
        "localizeDocument",
        "t",
        "getSettings",
        "mountRecordingControls",
        "agendaFolder",
        "bindAgendaTextInput",
        "subscribeAgenda",
        "formatMeetingTime",
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
        async () => ({ folder: vi.fn(), destroy: vi.fn() }),
        () => ({}),
        bindAgendaTextInput,
        subscribe,
        formatMeetingTime,
    );
}

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
        expect(el("point-count").textContent).toBe("1 of 3 discussed");
        el("live").click();
        const checkboxes = () =>
            el("points").querySelectorAll('input[type="checkbox"]');
        checkboxes()[1].click();
        await settle();
        expect(el("point-count").textContent).toBe("1 of 3 discussed");
        expect(checkboxes()[0].checked).toBe(true);
        checkboxes()[2].click();
        await settle();
        expect(el("point-count").textContent).toBe("2 of 3 discussed");
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
            doc.getElementById("live").click();
            const note = doc.querySelector('#points input[type="text"]');
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
            doc.querySelector("#tasks button").click();
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
        first.getElementById("other").click();
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
    it("shows prep outline, nested points, task groups, notes and the stable app link", async () => {
        await start();
        expect(el("title").textContent).toBe("Acme review");
        expect(el("points").children[1].style.marginInlineStart).toBe("16px");
        expect(el("tasks").textContent).toContain("Assignee note");
        expect(el("tasks").textContent).toContain("Not invited");
        el("open-app").click();
        await settle();
        expect(chrome.tabs.create).toHaveBeenCalledWith({
            url: "https://recorder.example.com/meetings/meeting-one",
        });
    });
    it("saves discussed ticks and notes with each point's current version", async () => {
        await start();
        el("live").click();
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
        const note = el("points").querySelector('input[type="text"]');
        note.value = "Move to next week";
        note.dispatchEvent(new Event("change"));
        await settle();
        expect(request).toHaveBeenCalledWith(
            "/agenda-one/points/p1",
            expect.objectContaining({
                body: JSON.stringify({ version: 3, note: "Move to next week" }),
            }),
        );
        expect(el("points").querySelector('input[type="text"]').value).toBe(
            "Move to next week",
        );
    });
    it("quick-adds a point and honors distinct Done and Drop task permissions", async () => {
        await start();
        el("live").click();
        const actions = el("tasks").querySelectorAll("button");
        expect([...actions].map((node) => node.disabled)).toEqual([
            false,
            true,
            true,
            false,
        ]);
        actions[0].click();
        await settle();
        expect(request).toHaveBeenCalledWith(
            "/agenda-one/tasks/task-one",
            expect.objectContaining({
                body: JSON.stringify({ version: 3, status: "done" }),
            }),
        );
        el("point-text").value = "Follow-up";
        el("quick-add").dispatchEvent(
            new Event("submit", { cancelable: true }),
        );
        await settle();
        expect(request).toHaveBeenCalledWith(
            "/agenda-one/points",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ text: "Follow-up" }),
            }),
        );
        expect(el("points").textContent).toContain("Follow-up");
    });
    it("explains a version conflict, rolls back and loads colleagues' changes", async () => {
        await start();
        el("live").click();
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
        expect(el("attachment-text").textContent).toBe(
            "The recording will carry this agenda",
        );
        expect(el("recording-state").textContent).toContain("Recording");
        el("other").click();
        await settle();
        el("choice-list").querySelectorAll("button")[1].click();
        await settle();
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "select-agenda",
            agendaId: "agenda-two",
            sessionId: "session-one",
            tabId: 7,
        });
        el("other").click();
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
        el("live").click();
        expect(el("quick-add").hidden).toBe(true);
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
        expect(el("recording-state").textContent).toBe(
            catalog.agendaUnavailable.message,
        );
        expect(el("retry").hidden).toBe(true);
        expect(el("attachment").hidden).toBe(true);
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
        expect(el("open-app").hidden).toBe(true);
        expect(el("status").textContent).toContain("Could not load");
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
        el("live").click();
        const note = el("points").querySelector("input[type=text]");
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
    it("keeps Preparation selected during recording and reveals controls only after Record too", async () => {
        data.recordingBy = [{ name: "Jitka Dvořáková", self: false }];
        await start();
        expect(el("recording-by").textContent).toContain("Jitka Dvořáková");
        expect(el("recorder-controls").hidden).toBe(true);
        el("record-also").click();
        expect(el("recorder-controls").hidden).toBe(false);
        session.recordingState = {
            state: "recording",
            sessionId: "session-one",
            startedAt: new Date().toISOString(),
        };
        await chrome.storage.session.set({
            recordingState: session.recordingState,
        });
        await settle();
        expect(el("live").getAttribute("aria-pressed")).toBe("true");
        el("prep").click();
        await vi.advanceTimersByTimeAsync(15000);
        expect(el("prep").getAttribute("aria-pressed")).toBe("true");
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
    it("reuses the shared CRDT binding, keeps a focused input/caret, and flushes its materialized version before ticking", async () => {
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
        el("live").click();
        const note = el("points").querySelector("input[type=text]");
        note.focus();
        await settle();
        expect(note.value).toBe("Initial");
        note.setSelectionRange(3, 3);
        ytext.insert(0, "Remote ");
        await subscription.invalidate();
        await settle();
        expect(el("points").querySelector("input[type=text]")).toBe(note);
        expect(document.activeElement).toBe(note);
        expect(note.value).toBe("Remote Initial");
        expect(note.selectionStart).toBe(10);
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
