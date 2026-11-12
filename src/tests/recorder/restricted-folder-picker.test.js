// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFolderField } from "../../../extensions/recorder/bundle/folders.jsx";

const catalog = JSON.parse(
    readFileSync("extensions/recorder/_locales/en/messages.json", "utf8"),
);
const t = (key) => catalog[key]?.message ?? key;
let fields;
beforeEach(() => {
    fields = [];
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
        storage: { local: { get: async () => ({}), set: vi.fn() } },
    });
});
afterEach(async () => {
    await act(async () => {
        for (const field of fields) field.destroy();
    });
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});
function mount(request, save, variant) {
    const container = document.createElement("div");
    document.body.append(container);
    const field = createFolderField({ container, request, save, variant, t });
    fields.push(field);
    return { field, container };
}
describe.each([
    "field",
    "pill",
])("restricted recorder folders (%s)", (variant) => {
    it.each([
        true,
        false,
    ])("accepts current and released-server responses (restricted=%s)", async (restricted) => {
        const folder = {
            id: "pilot",
            name: "Pilot",
            path: "Organization / Pilot",
            scope: "org",
            ...(restricted ? { restricted: true } : {}),
        };
        const save = vi.fn();
        const { field, container } = mount(
            async () => ({ ok: true, folders: [folder] }),
            save,
            variant,
        );
        await act(async () =>
            field.reset({
                folderId: "pilot",
                folderLabel: folder.path,
                folderScope: "org",
            }),
        );
        await field.saved();
        const trigger = container.querySelector("button");
        expect(
            !!trigger.querySelector(".lucide-folder-lock.text-restricted"),
        ).toBe(restricted);
        expect(!!trigger.querySelector(".lucide-users.text-organization")).toBe(
            !restricted,
        );
        await act(async () => fireEvent.click(trigger));
        const entry = screen.getByRole("option", {
            name: "Pilot Organization",
        });
        expect(
            !!entry.querySelector(".lucide-folder-lock.text-restricted"),
        ).toBe(restricted);
        expect(save).toHaveBeenLastCalledWith({
            folderId: "pilot",
            folderLabel: folder.path,
            folderScope: "org",
        });
    });
    it("clears an unavailable saved target and explains the result", async () => {
        const save = vi.fn();
        const request = vi.fn(async ({ id }) =>
            id ? { ok: false, status: 404 } : { ok: true, folders: [] },
        );
        const { field, container } = mount(request, save, variant);
        await act(async () =>
            field.reset({
                folderId: "gone",
                folderLabel: "Organization / Pilot",
                folderScope: "org",
            }),
        );
        await field.saved();
        expect(request).toHaveBeenCalledWith({ id: "gone" });
        expect(save).toHaveBeenLastCalledWith({
            folderId: null,
            folderLabel: null,
            folderScope: null,
        });
        expect(container.textContent).toContain(t("folderUnavailable"));
    });
});
it("ships a higher version and both restricted colour tokens in the built CSS", () => {
    expect(
        JSON.parse(readFileSync("extensions/recorder/manifest.json", "utf8"))
            .version,
    ).toBe("0.9.9");
    const css = readFileSync(
        "extensions/recorder/generated/folders.css",
        "utf8",
    );
    expect(css).toMatch(/--restricted:\s*#647119/);
    expect(css).toMatch(/--restricted:\s*#b7c86b/);
    expect(css).toContain("text-restricted");
});
