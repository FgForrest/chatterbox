// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    AGENDA_PANEL_KEY,
    canChooseRecordingAgenda,
} from "../../../extensions/recorder/lib/agendas.js";
import { localizeDocument, t } from "../../../extensions/recorder/lib/i18n.js";

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
let onChange;
let matches;
const el = (id) => document.getElementById(id);
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(async () => {
    vi.useFakeTimers();
    document.documentElement.innerHTML = html;
    settings = { serverUrl: "https://recorder.example.com", supported: true };
    session = {
        [AGENDA_PANEL_KEY]: { agendaIds: ["agenda-one"], tabId: 7 },
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
                    onChange?.(
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
                    onChange = fn;
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

async function start() {
    const run = new Function(
        "AGENDA_PANEL_KEY",
        "canChooseRecordingAgenda",
        "agendaRequest",
        "matchAgendas",
        "supportsAgendas",
        "localizeDocument",
        "t",
        "getSettings",
        `return (async () => { ${source} })();`,
    );
    await run(
        AGENDA_PANEL_KEY,
        canChooseRecordingAgenda,
        request,
        matches,
        (value) => value.supported,
        localizeDocument,
        t,
        async () => settings,
    );
}

describe("agenda side panel", () => {
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
