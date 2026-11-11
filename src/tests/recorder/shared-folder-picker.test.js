// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { mapRecorderFolders } from "../../../extensions/recorder/lib/api.js";
import { createFolderField } from "../../../extensions/recorder/popup/folder-combobox.js";

afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
});
it("renders additive shared-folder marks while keeping options from released servers usable", async () => {
    vi.useFakeTimers();
    const data = [
        {
            id: "shared",
            name: "My Acme",
            path: "Private / My Acme",
            scope: "personal",
            sharedWithPeople: true,
        },
        {
            id: "own",
            name: "Acme calls",
            path: "Private / Acme calls",
            scope: "personal",
        },
        {
            id: "restricted",
            name: "Acme pilot",
            path: "Organization / Acme pilot",
            scope: "org",
            restricted: true,
        },
        {
            id: "organization",
            name: "Acme team",
            path: "Organization / Acme team",
            scope: "org",
        },
    ];
    const container = document.createElement("div");
    document.body.append(container);
    const save = vi.fn().mockResolvedValue(undefined);
    const picker = createFolderField({
        container,
        t: (key) => key,
        request: async () => ({
            ok: true,
            folders: mapRecorderFolders({ data }),
        }),
        save,
    });
    picker.reset({});
    const input = document.getElementById("folder-picker");
    input.focus();
    input.value = "acme";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(201);
    const options = [...document.querySelectorAll('[role="option"]')];
    const shared = options.find(
        (option) => option.textContent === "Private / My Acme",
    );
    const own = options.find(
        (option) => option.textContent === "Private / Acme calls",
    );
    expect(shared.querySelector("svg")).toBeTruthy();
    expect(own.querySelector("svg")).toBeNull();
    const restricted = options.find(
        (option) => option.textContent === "Organization / Acme pilot",
    );
    const organization = options.find(
        (option) => option.textContent === "Organization / Acme team",
    );
    const lock = restricted.querySelector(".lucide-folder-lock");
    expect(lock).toBeTruthy();
    expect(lock.style.color).toBe("var(--restricted, #647119)");
    expect(lock.getAttribute("aria-hidden")).toBe("true");
    expect(organization.querySelector("svg")).toBeNull();
    shared.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledWith({
        folderId: "shared",
        folderLabel: "Private / My Acme",
        folderScope: "personal",
    });
});
