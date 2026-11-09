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
const t = (key, substitution = "") =>
    (catalog[key]?.message ?? key).replace("$1", substitution);
const trigger = () => document.querySelector(".recorder-folder-target button");
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
    document.body.removeAttribute("class");
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
        expect(trigger().textContent).toBe("Calls");
        expect(trigger().title).toBe("Private / Calls");
        await act(async () => fireEvent.click(trigger()));
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
            folderScope: null,
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
        await act(async () => fireEvent.click(trigger()));
        await act(async () =>
            fireEvent.click(screen.getAllByText("Planning")[0]),
        );
        expect(local.recorderRecentFolders[0]).toBe("work");
        save.mockRejectedValueOnce(new Error("Refused"));
        await act(async () => fireEvent.click(trigger()));
        await act(async () => fireEvent.click(screen.getByText("Calls")));
        expect(container.textContent).toContain("Planning");
        expect(container.textContent).toContain("Refused");
    });
});

it("grows the action popup only while its folder list is open", async () => {
    const popup = new DOMParser().parseFromString(
        readFileSync("extensions/recorder/popup/popup.html", "utf8"),
        "text/html",
    ).body;
    document.body.className = popup.className;
    document.body.append(
        ...Array.from(popup.childNodes, (node) =>
            document.importNode(node, true),
        ),
    );
    const growRule = readFileSync(
        "extensions/recorder/popup/popup.css",
        "utf8",
    ).match(/^([^{}\n]*:has\(\[data-combobox-popup\]\)) \{\s*min-height/m);
    expect(growRule).toBeTruthy();
    document.getElementById("view-idle").hidden = false;
    const field = createFolderField({
        container: document.getElementById("folder-row"),
        request: async () => ({ ok: true, folders }),
        save: vi.fn(async () => {}),
        t,
    });
    fields.push(field);
    await act(async () => field.reset({ folderId: null }));
    expect(document.body.matches(growRule[1])).toBe(false);
    await act(async () => fireEvent.click(trigger()));
    expect(document.body.matches(growRule[1])).toBe(true);
    await act(async () =>
        fireEvent.keyDown(document.activeElement, { key: "Escape" }),
    );
    expect(document.querySelector("[data-combobox-popup]")).toBeNull();
    expect(document.body.matches(growRule[1])).toBe(false);
    await act(async () => fireEvent.click(trigger()));
    expect(document.body.matches(growRule[1])).toBe(true);
    await act(async () => field.close());
    expect(document.querySelector("[data-combobox-popup]")).toBeNull();
    expect(document.body.matches(growRule[1])).toBe(false);
    await act(async () => fireEvent.click(trigger()));
    expect(document.querySelector("[data-combobox-popup]")).toBeTruthy();
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
    expect(trigger().disabled).toBe(true);
    expect(
        screen.queryByRole("button", { name: "Remove from Calls" }),
    ).toBeNull();
    await act(async () => fireEvent.click(trigger()));
    expect(document.querySelector("[data-combobox-popup]")).toBeNull();
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

describe.each(["field", "pill"])("folder chip %s", (variant) => {
    it.each([
        true,
        false,
    ])("moves focus to Add to folder after removal and restores the select button on refusal (accepted=%s)", async (accepted) => {
        let finish;
        const field = createFolderField({
            container: mount(),
            request: vi.fn(),
            save: () =>
                new Promise((resolve, reject) => {
                    finish = () =>
                        accepted ? resolve() : reject(new Error("Refused"));
                }),
            t,
            variant,
        });
        fields.push(field);
        await act(async () =>
            field.reset(
                {
                    folderId: "work",
                    folderLabel: "Organization / Planning",
                    folderScope: "org",
                },
                { refresh: false },
            ),
        );
        const remove = screen.getByRole("button", {
            name: "Remove from Planning",
        });
        remove.focus();
        expect(document.activeElement).toBe(remove);
        await act(async () => fireEvent.click(remove));
        expect(trigger().textContent).toBe("Add to folder");
        expect(document.activeElement).toBe(trigger());
        await act(async () => finish());
        if (accepted) await expect(field.saved()).resolves.toBeUndefined();
        else {
            await expect(field.saved()).rejects.toThrow("Refused");
            expect(trigger().textContent).toBe("Planning");
        }
        expect(document.activeElement).toBe(trigger());
    });
    it.each([
        "Organization / Planning",
        "Organization › Planning",
    ])("uses the last segment, full title, organization icon and unfiles via ×: %s", async (folderLabel) => {
        const save = vi.fn(async () => {});
        const container = mount();
        const field = createFolderField({
            container,
            request: vi.fn(),
            save,
            t,
            variant,
        });
        fields.push(field);
        await act(async () =>
            field.reset(
                { folderId: "work", folderLabel, folderScope: "org" },
                { refresh: false },
            ),
        );
        expect(trigger().textContent).toBe("Planning");
        expect(trigger().title).toBe(folderLabel);
        expect(
            trigger().querySelector(".lucide-users.text-organization"),
        ).toBeTruthy();
        expect(
            trigger().parentElement.classList.contains("bg-organization/5"),
        ).toBe(true);
        if (variant === "field")
            expect(trigger().getAttribute("aria-label")).toBe(t("folder"));
        const remove = screen.getByRole("button", {
            name: "Remove from Planning",
        });
        await act(async () => fireEvent.click(remove));
        await field.saved();
        expect(save).toHaveBeenLastCalledWith({
            folderId: null,
            folderLabel: null,
            folderScope: null,
        });
        expect(container.querySelector(".lucide-users")).toBeNull();
        expect(trigger().textContent).toBe("Add to folder");
        expect(trigger().querySelector(".lucide-folder-plus")).toBeTruthy();
        await act(async () => fireEvent.click(trigger()));
        expect(screen.getByRole("option", { name: "File later" })).toBeTruthy();
    });
    it("anchors the list to the chip and retains open state through a reset", async () => {
        const field = createFolderField({
            container: mount(),
            request: async () => ({ ok: true, folders }),
            save: vi.fn(),
            t,
            variant,
        });
        fields.push(field);
        const value = {
            folderId: "calls",
            folderLabel: "Private / Calls",
            folderScope: "personal",
        };
        await act(async () => field.reset(value));
        vi.spyOn(trigger(), "getBoundingClientRect").mockReturnValue({
            left: 24,
            top: 40,
            right: 144,
            bottom: 68,
            width: 120,
            height: 28,
        });
        await act(async () => fireEvent.click(trigger()));
        const popup = document.querySelector("[data-combobox-popup]");
        expect(popup.style.position).toBe("fixed");
        expect(popup.style.top).toBe("72px");
        expect(popup.style.left).toBe("24px");
        await act(async () => field.reset(value));
        expect(document.querySelector("[data-combobox-popup]")).toBe(popup);
        await act(async () => field.close());
        expect(document.querySelector("[data-combobox-popup]")).toBeNull();
    });
    it("refreshes a remembered folder's scope through lookup when it is absent from the list", async () => {
        const save = vi.fn();
        const field = createFolderField({
            container: mount(),
            request: async ({ id }) => ({
                ok: true,
                folders: id ? [folders[1]] : [],
            }),
            save,
            t,
            variant,
        });
        fields.push(field);
        await act(async () =>
            field.reset({
                folderId: "work",
                folderLabel: "Previous / Planning",
            }),
        );
        await field.saved();
        expect(trigger().title).toBe("Organization / Planning");
        expect(
            trigger().querySelector(".lucide-users.text-organization"),
        ).toBeTruthy();
        expect(save).toHaveBeenLastCalledWith({
            folderId: "work",
            folderLabel: "Organization / Planning",
            folderScope: "org",
        });
    });
    it("renders unknown scopes as private and learns the scope on refresh", async () => {
        const save = vi.fn();
        const field = createFolderField({
            container: mount(),
            request: async () => ({ ok: true, folders }),
            save,
            t,
            variant,
        });
        fields.push(field);
        const value = {
            folderId: "work",
            folderLabel: "Organization / Planning",
        };
        await act(async () => field.reset(value, { refresh: false }));
        expect(
            trigger().querySelector(".lucide-folder.text-primary"),
        ).toBeTruthy();
        await act(async () => field.reset(value));
        await field.saved();
        expect(save).toHaveBeenLastCalledWith({ ...value, folderScope: "org" });
        expect(
            trigger().querySelector(".lucide-users.text-organization"),
        ).toBeTruthy();
    });
});

it("settles the recording wrapper's saved promise after a refused removal while retaining the folder and error", async () => {
    const container = mount();
    const field = createRecordingFolder({
        container,
        request: async () => ({ ok: true, folders: [] }),
        send: async () => ({ ok: false, error: "Refused" }),
        t,
    });
    fields.push(field);
    await act(async () =>
        field.render({
            state: "recording",
            sessionId: "one",
            folderId: "work",
            folderLabel: "Organization / Planning",
            recordingFolderOverride: true,
        }),
    );
    await act(async () =>
        fireEvent.click(
            screen.getByRole("button", { name: "Remove from Planning" }),
        ),
    );
    await expect(field.saved()).resolves.toBeUndefined();
    expect(trigger().textContent).toBe("Planning");
    expect(container.textContent).toContain("Refused");
});

it("grows the fitted picker only while its bundled folder list is open", async () => {
    const picker = new DOMParser().parseFromString(
        readFileSync("extensions/recorder/picker/picker.html", "utf8"),
        "text/html",
    );
    expect(
        picker.querySelector('link[href="../generated/folders.css"]'),
    ).toBeTruthy();
    document.body.className = "recorder-picker";
    const rule = readFileSync(
        "extensions/recorder/picker/picker.css",
        "utf8",
    ).match(/^([^{}\n]*:has\(\[data-combobox-popup\]\)) \{\s*min-height/m);
    const field = createRecordingFolder({
        container: mount(),
        prefix: "picker",
        request: async () => ({ ok: true, folders }),
        send: async () => ({ ok: true }),
        t,
    });
    fields.push(field);
    await act(async () =>
        field.render({
            state: "recording",
            sessionId: "one",
            folderId: "work",
            folderLabel: "Organization / Planning",
            folderScope: "org",
            recordingFolderOverride: true,
        }),
    );
    expect(document.body.matches(rule[1])).toBe(false);
    await act(async () => fireEvent.click(trigger()));
    expect(document.body.matches(rule[1])).toBe(true);
    await act(async () => field.render({ state: "finalizing" }));
    expect(document.body.matches(rule[1])).toBe(false);
});
