// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createFolderField,
    createRecordingFolder,
} from "../../../extensions/recorder/bundle/folders.jsx";

let fields;
let local;
const folders = [
    {
        id: "private",
        name: "Private",
        path: "Private",
        scope: "personal",
        kind: "private",
        parentId: null,
    },
    {
        id: "work",
        name: "Planning",
        path: "Organization / Planning",
        scope: "org",
        sharedWithPeople: true,
    },
    { id: "calls", name: "Calls", path: "Private / Calls", scope: "personal" },
];
const catalog = JSON.parse(
    readFileSync("extensions/recorder/_locales/en/messages.json", "utf8"),
);
const t = (key) => catalog[key]?.message ?? key;
beforeEach(() => {
    fields = [];
    local = { recorderRecentFolders: ["work"] };
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            disconnect() {}
            unobserve() {}
        },
    );
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("chrome", {
        storage: {
            local: {
                get: async () => local,
                set: async (patch) => Object.assign(local, patch),
            },
        },
    });
});
afterEach(async () => {
    await act(async () => {
        for (const field of fields) field.destroy();
    });
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});
function mount() {
    const node = document.createElement("div");
    document.body.append(node);
    return node;
}

describe.each([
    "field",
    "pill",
])("bundled application folder picker %s", (variant) => {
    it("shows localized groups, recents, full paths, shared icons and saves File later", async () => {
        const save = vi.fn(async () => {});
        const field = createFolderField({
            container: mount(),
            request: async () => ({ ok: true, folders }),
            save,
            t,
            variant,
        });
        fields.push(field);
        await act(async () =>
            field.reset({ folderId: "calls", folderLabel: "Private / Calls" }),
        );
        expect(
            screen
                .getByRole("combobox")
                .querySelector("span")
                .classList.contains("text-left"),
        ).toBe(true);
        await act(async () => fireEvent.click(screen.getByRole("combobox")));
        expect(screen.getByText("Recently used")).toBeTruthy();
        expect(
            screen.getByText("Organization", {
                selector: "[cmdk-group-heading]",
            }),
        ).toBeTruthy();
        expect(screen.getAllByText("Planning").length).toBe(2);
        expect(document.querySelector(".text-organization")).toBeTruthy();
        await act(async () =>
            fireEvent.click(screen.getByRole("option", { name: "File later" })),
        );
        await field.saved();
        expect(save).toHaveBeenLastCalledWith({
            folderId: null,
            folderLabel: null,
        });
    });
    it("remembers selected folder IDs and retains the previous selection after a refused save", async () => {
        const save = vi.fn(async () => {});
        const container = mount();
        const field = createFolderField({
            container,
            request: async () => ({ ok: true, folders }),
            save,
            t,
            variant,
        });
        fields.push(field);
        await act(async () => field.reset({ folderId: null }));
        await act(async () => fireEvent.click(screen.getByRole("combobox")));
        await act(async () =>
            fireEvent.click(screen.getAllByText("Planning")[0]),
        );
        expect(local.recorderRecentFolders[0]).toBe("work");
        save.mockRejectedValueOnce(new Error("Refused"));
        await act(async () => fireEvent.click(screen.getByRole("combobox")));
        await act(async () => fireEvent.click(screen.getByText("Calls")));
        expect(container.textContent).toContain("Planning");
        expect(container.textContent).toContain("Refused");
    });
});

it("makes the recording folder read-only on a released server", async () => {
    const field = createRecordingFolder({
        container: mount(),
        prefix: "recording",
        request: vi.fn(),
        send: vi.fn(),
        t,
    });
    fields.push(field);
    await act(async () =>
        field.render({
            state: "recording",
            sessionId: "one",
            folderId: "calls",
            folderLabel: "Private / Calls",
            recordingFolderOverride: false,
        }),
    );
    expect(screen.getByRole("combobox").disabled).toBe(true);
    expect(document.body.textContent).toContain(t("folderFixedAtStart"));
});

it("reports a failed recording-folder refresh without losing the remembered choice or rejecting unobserved", async () => {
    const container = mount();
    const field = createFolderField({
        container,
        request: async () => ({ ok: true, folders }),
        save: vi.fn(),
        saveOnRefresh: async () => {
            throw new Error("Refused refresh");
        },
        t,
    });
    fields.push(field);
    await act(async () =>
        field.reset({ folderId: "calls", folderLabel: "Private / Calls" }),
    );
    await expect(field.saved()).rejects.toThrow("Refused refresh");
    expect(container.textContent).toContain("Calls");
    expect(container.textContent).toContain("Refused refresh");
});
