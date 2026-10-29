// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskRow } from "@/components/tasks/task-row";
import type { AppLocale } from "@/lib/i18n/config";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import type { TaskView } from "@/lib/tasks/tasks";

const { toastError, locale } = vi.hoisted(() => ({
    toastError: vi.fn(),
    locale: { current: "en" as AppLocale },
}));

vi.mock("sonner", () => ({ toast: { error: toastError } }));
vi.mock("next-intl", () => ({
    useExtracted: () => (text: string, values?: Record<string, string>) =>
        translatedSourceMessage(locale.current, text, values),
    useFormatter: () => ({
        dateTime: (value: Date) => value.toISOString().slice(0, 10),
    }),
}));

function task(overrides: Partial<TaskView> = {}): TaskView {
    return {
        id: "task-1",
        recordingId: "recording-1",
        evidenceItemId: "recording-1",
        evidenceItemKind: "audio",
        evidenceAudioAvailable: true,
        status: "open",
        text: "Send the draft",
        assignee: { personId: "person-1", name: "Karel Kratochvíl" },
        assigneeHasEmail: true,
        assigneeHint: null,
        assigneeCheck: false,
        dueDate: null,
        duePhrase: null,
        quote: null,
        evidenceStartMs: null,
        evidenceText: null,
        evidenceProvenance: null,
        source: "manual",
        ticked: true,
        version: 0,
        createdAt: "2026-10-20T00:00:00Z",
        acceptedAt: null,
        statusChangedAt: null,
        canEdit: false,
        canClose: false,
        canUndoMatch: false,
        own: false,
        note: null,
        noteUpdatedAt: null,
        noteBy: null,
        following: false,
        automaticFollow: false,
        canFollow: false,
        canMerge: false,
        ...overrides,
    };
}

function renderTask(value: TaskView) {
    const onChange = vi.fn();
    render(<TaskRow task={value} organizationOnly onChange={onChange} />);
    return {
        onChange,
        checkbox: screen.queryByRole("checkbox"),
        mark: screen.queryByRole("img"),
    };
}

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    toastError.mockReset();
    locale.current = "en";
});

it.each(["open", "done"] as const)("toggles a closable %s task", (status) => {
    const { checkbox, onChange } = renderTask(task({ status, canClose: true }));
    if (!checkbox) throw new Error("Missing checkbox");
    expect(checkbox).toHaveProperty("disabled", false);
    expect(checkbox.hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(checkbox);
    const next = status === "open" ? "done" : "open";
    expect(onChange).toHaveBeenCalledExactlyOnceWith(
        { status: next },
        { status: next },
    );
    expect(toastError).not.toHaveBeenCalled();
});

const cases = [
    {
        label: "an assignee with an email",
        overrides: { assigneeHasEmail: true },
        en: "Assigned to Karel Kratochvíl. Only they, the recording's owner or a curator can mark it done.",
        cs: "Přiřazeno: Karel Kratochvíl. Hotovo může označit jen přiřazená osoba, vlastník nahrávky nebo kurátor.",
    },
    {
        label: "an assignee without an email",
        overrides: { assigneeHasEmail: false },
        en: "Assigned to Karel Kratochvíl, who has no email in the Almanac, so the task is on nobody's list.",
        cs: "Přiřazeno: Karel Kratochvíl, ale tato osoba nemá v Almanachu e-mail, takže úkol nemá nikdo ve svém seznamu.",
    },
    {
        label: "no assignee",
        overrides: { assignee: null, assigneeHasEmail: false },
        en: "Nobody is assigned yet. Only the recording's owner or a curator can mark it done.",
        cs: "Úkol zatím nikdo nemá. Hotovo může označit jen vlastník nahrávky nebo kurátor.",
    },
] satisfies {
    label: string;
    overrides: Partial<TaskView>;
    en: string;
    cs: string;
}[];

describe.each([
    "en",
    "cs-CZ",
] as const)("unavailable status mark in %s", (language) => {
    it.each(
        cases,
    )("explains $label on hover without offering a checkbox", async ({
        overrides,
        en,
        cs,
    }) => {
        locale.current = language;
        const value = task(overrides);
        const { mark, checkbox, onChange } = renderTask(value);
        expect(checkbox).toBeNull();
        if (!mark) throw new Error("Missing status mark");
        expect(mark.getAttribute("aria-label")).toBe(
            language === "en" ? "Open" : "Otevřené",
        );
        expect(mark.querySelector(".lucide-circle")).toBeTruthy();
        fireEvent.pointerMove(mark, { pointerType: "mouse" });
        expect((await screen.findByRole("tooltip")).textContent).toBe(
            language === "en" ? en : cs,
        );
        fireEvent.click(mark);
        expect(toastError).not.toHaveBeenCalled();
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getByText(value.text).className).not.toMatch(
            /opacity|text-muted/,
        );
    });

    it.each(
        cases,
    )("explains $label to keyboard users who focus the mark", async ({
        overrides,
        en,
        cs,
    }) => {
        locale.current = language;
        const { mark } = renderTask(task(overrides));
        if (!mark) throw new Error("Missing status mark");
        expect(mark.tabIndex).toBe(0);
        act(() => mark.focus());
        expect(document.activeElement).toBe(mark);
        expect((await screen.findByRole("tooltip")).textContent).toBe(
            language === "en" ? en : cs,
        );
    });
});

it("keeps a status mark without a reason out of the tab order", () => {
    const { mark } = renderTask(
        task({ canEdit: true, canClose: true, status: "dropped" }),
    );
    if (!mark) throw new Error("Missing status mark");
    expect(mark.hasAttribute("tabindex")).toBe(false);
});

it("shows a completed status mark and keeps the text struck through", () => {
    const { mark, checkbox, onChange } = renderTask(task({ status: "done" }));
    expect(checkbox).toBeNull();
    expect(mark?.getAttribute("aria-label")).toBe("Done");
    expect(mark?.querySelector(".lucide-circle-check")).toBeTruthy();
    expect(
        screen.getByText("Send the draft").classList.contains("line-through"),
    ).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
});

it.each([
    true,
    false,
])("shows a dropped status mark with canClose=%s", (canClose) => {
    const { mark, checkbox } = renderTask(
        task({ status: "dropped", canClose }),
    );
    expect(checkbox).toBeNull();
    expect(mark?.getAttribute("aria-label")).toBe("Dropped");
    expect(mark?.querySelector(".lucide-circle-slash")).toBeTruthy();
    expect(screen.queryByRole("tooltip")).toBeNull();
});

it("renders a read-only agenda task without mutation controls", () => {
    const onChange = vi.fn();
    render(
        <TaskRow
            task={task({ canEdit: true, canClose: true })}
            readOnly
            organizationOnly
            onChange={onChange}
        />,
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("img", { name: "Open" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Drop" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Note" })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
});

it("keeps a disabled done checkbox in place while a save is pending", () => {
    const onChange = vi.fn();
    const { rerender } = render(
        <TaskRow
            task={task({ canEdit: true, canClose: true, status: "done" })}
            pending
            organizationOnly
            onChange={onChange}
        />,
    );
    const checkbox = screen.getByRole("checkbox", {
        name: "Done",
    }) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(true);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("button", { name: "Drop" })).toBeNull();

    rerender(
        <TaskRow
            task={task({ canEdit: true, canClose: false })}
            pending
            organizationOnly
            onChange={onChange}
        />,
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("img", { name: "Open" })).toBeTruthy();
});
describe.each([true, false])("task action line with editing=%s", (canEdit) => {
    it.each([
        true,
        false,
    ])("keeps the follow toggle last with following=%s", (following) => {
        render(
            <TaskRow
                task={task({
                    canEdit,
                    canUndoMatch: canEdit,
                    canClose: canEdit,
                    canFollow: true,
                    following,
                })}
                organizationOnly
                onChange={vi.fn()}
                onMerge={vi.fn()}
                onUndoMatch={vi.fn()}
                badges={
                    <>
                        <span>Older</span>
                        <span>Changed during the meeting</span>
                    </>
                }
                actions={<button type="button">Add</button>}
            />,
        );
        const follow = screen.getByRole("button", {
            name: following ? "Following" : "Follow",
        });
        const actionLine = follow.closest(".task-row-actions");
        expect(actionLine?.lastElementChild).toBe(follow);
        expect(follow.getAttribute("aria-pressed")).toBe(String(following));
        expect(follow.title).toBe(following ? "Stop following" : "Follow");
        expect(follow.classList.contains("task-following")).toBe(following);
        expect(follow.classList.contains("text-primary")).toBe(following);
        const hoverTools = actionLine?.querySelector(".task-row-hover-actions");
        expect(hoverTools).toBeInstanceOf(HTMLElement);
        if (!(hoverTools instanceof HTMLElement))
            throw new Error("Missing hover tools");
        expect(hoverTools.nextElementSibling).toBe(follow);
        expect(within(hoverTools).queryByText("Older")).toBeNull();
        expect(
            within(hoverTools).queryByText("Changed during the meeting"),
        ).toBeNull();
        expect(
            screen.getByText("Older").closest(".task-row-pills"),
        ).toBeTruthy();
        expect(
            within(hoverTools).getByRole("button", { name: "Add" }),
        ).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Drop" }) !== null).toBe(
            canEdit,
        );
        expect(
            screen.queryByRole("button", { name: "Undo match" }) !== null,
        ).toBe(canEdit);
    });
});

it.each([
    { name: "Note", status: "open" },
    { name: "Merge into another task", status: "open" },
    { name: "Undo match", status: "open" },
    { name: "Drop", status: "open" },
    { name: "Restore", status: "dropped" },
] as const)("renders $name as an icon button with a focus tooltip", async ({
    name,
    status,
}) => {
    render(
        <TaskRow
            task={task({
                status,
                canClose: true,
                canEdit: true,
                canUndoMatch: true,
            })}
            organizationOnly
            onChange={vi.fn()}
            onMerge={vi.fn()}
            onUndoMatch={vi.fn()}
        />,
    );
    const button = screen.getByRole("button", { name });
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.classList.contains("size-6")).toBe(true);
    expect(button.classList.contains("hover:bg-accent")).toBe(true);
    expect(button.classList.contains("text-muted-foreground")).toBe(true);
    expect(button.classList.contains("hover:text-foreground")).toBe(true);
    act(() => button.focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe(name);
});

it("closes and drops live tasks while keeping the assignee note read-only", () => {
    const onChange = vi.fn();
    render(
        <TaskRow
            task={task({ canEdit: true, canClose: true })}
            notesReadOnly
            organizationOnly
            onChange={onChange}
        />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith(
        { status: "done" },
        { status: "done" },
    );
    expect(screen.queryByLabelText("Note")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Drop" }));
    expect(onChange).toHaveBeenCalledWith(
        { status: "dropped" },
        { status: "dropped" },
    );
});

it("focuses the proportional auto-growing note field and saves through the shared actions", () => {
    const height = vi
        .spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
        .mockReturnValue(100);
    const { onChange } = renderTask(task({ canClose: true }));
    fireEvent.click(screen.getByRole("button", { name: "Note" }));
    const field = screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Note",
    });
    expect(document.activeElement).toBe(field);
    expect(field.dataset.slot).toBe("textarea");
    expect(field.maxLength).toBe(2000);
    expect(field.classList.contains("font-mono")).toBe(false);
    expect(field.classList.contains("resize-y")).toBe(false);
    for (const className of [
        "text-base",
        "md:text-sm",
        "resize-none",
        "min-h-20",
        "max-h-[50vh]",
    ])
        expect(field.classList.contains(className)).toBe(true);
    expect(field.style.height).toBe("100px");
    height.mockReturnValue(320);
    fireEvent.change(field, {
        target: { value: "  A longer note\nwith a second line.  " },
    });
    expect(field.style.height).toBe("320px");
    for (const name of ["Skip", "Save note"])
        expect(
            screen.getByRole("button", { name }).classList.contains("h-8"),
        ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(
        { note: "A longer note\nwith a second line." },
        { note: "A longer note\nwith a second line." },
    );
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
});

it("Skip closes the note without saving or clearing its draft", () => {
    const { onChange } = renderTask(
        task({ canClose: true, note: "Saved note" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
        target: { value: "Unsaved draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    expect(screen.getByText("Saved note")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Note" }));
    expect(
        screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Note" })
            .value,
    ).toBe("Unsaved draft");
});

it.each([
    "note",
    "editor",
    "badges",
    "extra notes",
])("keeps the pills/actions line last with %s", (state) => {
    const { container } = render(
        <TaskRow
            task={task({ canClose: true, canFollow: true, note: "Task note" })}
            organizationOnly
            onChange={vi.fn()}
            badges={state === "badges" ? <span>Visible state</span> : undefined}
            extraNotes={
                state === "extra notes" ? <p>Meeting note</p> : undefined
            }
        />,
    );
    if (state === "editor")
        fireEvent.click(screen.getByRole("button", { name: "Note" }));
    const pills = container.querySelector(".task-row-pills");
    expect(pills?.parentElement?.lastElementChild).toBe(pills);
    expect(
        container.querySelector(".task-row-hover-actions")?.textContent,
    ).not.toContain("Task note");
    if (state === "editor") {
        for (const name of ["Skip", "Save note"])
            expect(
                screen
                    .getByRole("button", { name })
                    .closest(".task-row-hover-actions"),
            ).toBeNull();
    }
    if (state === "badges")
        expect(
            screen.getByText("Visible state").closest(".task-row-actions"),
        ).toBeNull();
    if (state === "extra notes")
        expect(
            screen.getByText("Meeting note").closest(".task-row-pills"),
        ).toBeNull();
});

it("uses Zahodit for Drop and reserves Zrušit for Cancel in Czech", () => {
    locale.current = "cs-CZ";
    renderTask(task({ canEdit: true }));
    expect(screen.getByRole("button", { name: "Zahodit" })).toBeTruthy();
    expect(translatedSourceMessage("cs-CZ", "Cancel")).toBe("Zrušit");
    expect(translatedSourceMessage("cs-CZ", "Dropped")).toBe("Zahozené");
});
