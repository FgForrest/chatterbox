// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    getRecorderFolder,
    mapRecorderFolders,
    searchRecorderFolders,
} from "../../../extensions/recorder/lib/api.js";
import { createFolderCombobox } from "../../../extensions/recorder/popup/folder-combobox.js";

const popupHtml = readFileSync("extensions/recorder/popup/popup.html", "utf8");
const saved = { id: "saved", label: "Private / Calls" };
const auth = { serverUrl: "https://recorder.test", apiKey: "op_test" };
const folder = (id, path, scope = "personal") => ({
    id,
    name: path.split(" / ").at(-1),
    path,
    scope,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
});

function setup(
    settings = {},
    request = vi.fn(async () => ({ ok: true, folders: [] })),
) {
    document.body.innerHTML = popupHtml;
    const input = document.getElementById("folder-picker");
    const listbox = document.getElementById("folder-listbox");
    const status = document.getElementById("folder-status");
    const panel = document.getElementById("folder-results");
    const save = vi.fn(async () => {});
    const controller = createFolderCombobox({
        input,
        listbox,
        panel,
        status,
        request,
        save,
        t: (key) => key,
    });
    controller.reset(settings);
    return {
        input,
        listbox,
        status,
        panel,
        save,
        request,
        controller,
        labels: () => Array.from(listbox.children, (node) => node.textContent),
        type: (q) => {
            input.value = q;
            input.dispatchEvent(new Event("input"));
        },
        key: (key) =>
            input.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key,
                    bubbles: true,
                    cancelable: true,
                }),
            ),
    };
}

function deferred() {
    let resolve;
    const promise = new Promise((finish) => {
        resolve = finish;
    });
    return { promise, resolve };
}

describe("recorder folder API helpers", () => {
    it("drops unsafe entries and preserves the server's search ranking", () => {
        const data = [
            folder("org", "Organization / Sales", "org"),
            { id: "bad", name: "Missing scope", path: "Missing scope" },
            folder("personal", "Private / Calls"),
        ];
        expect(mapRecorderFolders({ data })).toEqual([
            { ...data[0], label: data[0].path },
            { ...data[2], label: data[2].path },
        ]);
        expect(mapRecorderFolders(null)).toEqual([]);
        expect(mapRecorderFolders({ data: [{ id: 3 }, null] })).toEqual([]);
    });
    it("encodes a trimmed search, authenticates and safely maps results", async () => {
        const data = [folder("match", "Organization / Žlutý & plán", "org")];
        const fetchMock = vi.fn(async () => Response.json({ data }));
        vi.stubGlobal("fetch", fetchMock);
        expect(await searchRecorderFolders(auth, "  Žlutý & plán  ")).toEqual([
            { ...data[0], label: data[0].path },
        ]);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(
            "https://recorder.test/api/v1/recorder/folders?q=%C5%BDlut%C3%BD%20%26%20pl%C3%A1n",
        );
        expect(init.headers.get("Authorization")).toBe("Bearer op_test");
    });
    it("looks up only the encoded remembered id", async () => {
        const data = [folder("saved/id", "Private / Renamed")];
        const fetchMock = vi.fn(async () => Response.json({ data }));
        vi.stubGlobal("fetch", fetchMock);
        expect(await getRecorderFolder(auth, "saved/id")).toEqual([
            { ...data[0], label: data[0].path },
        ]);
        expect(fetchMock.mock.calls[0][0]).toBe(
            "https://recorder.test/api/v1/recorder/folders?id=saved%2Fid",
        );
    });
    it("preserves 404 status so the popup can drop an unavailable remembered folder", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({ error: "Folder not found" }, { status: 404 }),
            ),
        );
        await expect(getRecorderFolder(auth, "gone")).rejects.toMatchObject({
            status: 404,
            message: "Folder not found",
        });
    });
});

describe("recorder folder combobox", () => {
    it("opens with File later only, connects accessible controls and never requests the full list", () => {
        const ui = setup();
        ui.input.focus();
        expect(ui.labels()).toEqual(["fileLater"]);
        expect(ui.request).not.toHaveBeenCalled();
        expect(ui.input.getAttribute("role")).toBe("combobox");
        expect(ui.input.getAttribute("aria-expanded")).toBe("true");
        expect(ui.input.getAttribute("aria-controls")).toBe(ui.listbox.id);
        expect(ui.listbox.getAttribute("role")).toBe("listbox");
    });
    it("shows the remembered label immediately and refreshes its current path by id", async () => {
        const response = deferred();
        const ui = setup(
            { folderId: saved.id, folderLabel: saved.label },
            vi.fn(() => response.promise),
        );
        ui.input.focus();
        expect(ui.labels()).toEqual(["fileLater", saved.label]);
        expect(ui.request).toHaveBeenCalledExactlyOnceWith({ id: saved.id });
        response.resolve({
            ok: true,
            folders: [{ id: saved.id, label: "Private / Renamed" }],
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(ui.labels()).toEqual(["fileLater", "Private / Renamed"]);
        expect(ui.save).toHaveBeenCalledWith({
            folderId: saved.id,
            folderLabel: "Private / Renamed",
        });
        ui.input.blur();
        expect(ui.input.value).toBe("Private / Renamed");
        expect(ui.input.title).toBe("Private / Renamed");
    });
    it("drops a remembered folder silently on 404", async () => {
        const ui = setup(
            { folderId: saved.id, folderLabel: saved.label },
            vi.fn(async () => ({ ok: false, status: 404 })),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(ui.input.value).toBe("fileLater");
        expect(ui.labels()).toEqual(["fileLater"]);
        expect(ui.status.textContent).toBe("");
        expect(ui.save).toHaveBeenCalledWith({
            folderId: null,
            folderLabel: null,
        });
    });
    it("keeps the remembered folder after a temporary lookup failure", async () => {
        const ui = setup(
            { folderId: saved.id },
            vi.fn(async () => {
                throw new Error("offline");
            }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(ui.input.value).toBe("savedFolder");
        expect(ui.save).not.toHaveBeenCalled();
    });
    it("debounces a keystroke burst and shows only remembered folders below two trimmed characters", async () => {
        const ui = setup();
        ui.type("p");
        await vi.advanceTimersByTimeAsync(300);
        expect(ui.request).not.toHaveBeenCalled();
        ui.type("pr");
        await vi.advanceTimersByTimeAsync(100);
        ui.type("pro");
        await vi.advanceTimersByTimeAsync(199);
        expect(ui.request).not.toHaveBeenCalled();
        expect(ui.status.textContent).toBe("foldersLoading");
        await vi.advanceTimersByTimeAsync(1);
        expect(ui.request).toHaveBeenCalledExactlyOnceWith({ q: "pro" });
        expect(ui.status.textContent).toBe("noFoldersFound");
        ui.type(" x ");
        expect(ui.status.textContent).toBe("");
        expect(ui.labels()).toEqual(["fileLater"]);
    });
    it("keeps at most one request running and discards stale responses and queued queries", async () => {
        const first = deferred();
        const last = deferred();
        const ui = setup(
            {},
            vi
                .fn()
                .mockReturnValueOnce(first.promise)
                .mockReturnValueOnce(last.promise),
        );
        ui.type("first");
        await vi.advanceTimersByTimeAsync(200);
        ui.type("middle");
        await vi.advanceTimersByTimeAsync(200);
        ui.type("latest");
        await vi.advanceTimersByTimeAsync(200);
        expect(ui.request).toHaveBeenCalledTimes(1);
        first.resolve({
            ok: true,
            folders: [{ id: "old", label: "Private / Old" }],
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(ui.labels()).toEqual(["fileLater"]);
        expect(ui.request).toHaveBeenLastCalledWith({ q: "latest" });
        last.resolve({
            ok: true,
            folders: [{ id: "new", label: "Private / Latest" }],
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(ui.labels()).toEqual(["fileLater", "Private / Latest"]);
        expect(ui.request).toHaveBeenCalledTimes(2);
    });
    it("ignores an in-flight search after clearing the query", async () => {
        const response = deferred();
        const ui = setup(
            {},
            vi.fn(() => response.promise),
        );
        ui.type("project");
        await vi.advanceTimersByTimeAsync(200);
        ui.type("");
        response.resolve({ ok: true, folders: [{ id: "old", label: "Old" }] });
        await vi.advanceTimersByTimeAsync(0);
        expect(ui.labels()).toEqual(["fileLater"]);
        expect(ui.status.textContent).toBe("");
    });
    it("supports arrows, Enter, Escape, mouse selection, and full path titles", async () => {
        const label = "Organization / Clients / Example";
        const ui = setup(
            {},
            vi.fn(async () => ({
                ok: true,
                folders: [{ id: "picked", label }],
            })),
        );
        ui.input.focus();
        ui.type("example");
        await vi.advanceTimersByTimeAsync(200);
        ui.key("ArrowDown");
        expect(ui.input.getAttribute("aria-activedescendant")).toBe(
            "folder-option-0",
        );
        ui.key("ArrowDown");
        expect(ui.input.getAttribute("aria-activedescendant")).toBe(
            "folder-option-1",
        );
        expect(ui.listbox.children[1].title).toBe(label);
        ui.key("Enter");
        await ui.controller.saved();
        expect(ui.save).toHaveBeenLastCalledWith({
            folderId: "picked",
            folderLabel: label,
        });
        expect(ui.input.value).toBe(label);
        expect(ui.input.getAttribute("aria-expanded")).toBe("false");
        ui.input.click();
        ui.key("ArrowUp");
        expect(ui.input.getAttribute("aria-activedescendant")).toBe(
            "folder-option-1",
        );
        ui.key("Escape");
        expect(ui.input.getAttribute("aria-expanded")).toBe("false");
        expect(ui.input.getAttribute("aria-activedescendant")).toBe("");
        ui.input.click();
        ui.listbox.children[0].click();
        await ui.controller.saved();
        expect(ui.save).toHaveBeenLastCalledWith({
            folderId: null,
            folderLabel: null,
        });
        expect(ui.input.value).toBe("fileLater");
    });
    it("does not overwrite a new selection with an old remembered-folder lookup", async () => {
        const response = deferred();
        const ui = setup(
            { folderId: saved.id, folderLabel: saved.label },
            vi.fn(() => response.promise),
        );
        ui.input.focus();
        ui.listbox.children[0].click();
        response.resolve({
            ok: true,
            folders: [{ id: saved.id, label: "Old refreshed" }],
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(ui.save).toHaveBeenCalledExactlyOnceWith({
            folderId: null,
            folderLabel: null,
        });
        expect(ui.input.value).toBe("fileLater");
    });
    it("distinguishes failed searches from no matches without changing the saved selection", async () => {
        const ui = setup(
            {},
            vi.fn(async () => ({ ok: false, status: 503 })),
        );
        ui.type("project");
        await vi.advanceTimersByTimeAsync(200);
        expect(ui.status.textContent).toBe("folderSearchFailed");
        ui.input.blur();
        expect(ui.save).not.toHaveBeenCalled();
    });
});
