// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
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
        assignee: { personId: "person-1", name: "Karel Vondra" },
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
        ...overrides,
    };
}

function renderTask(value: TaskView) {
    const onChange = vi.fn();
    render(<TaskRow task={value} organizationOnly onChange={onChange} />);
    return { onChange, checkbox: screen.getByRole("checkbox") };
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
    vi.unstubAllGlobals();
    toastError.mockReset();
    locale.current = "en";
});

it.each(["open", "done"] as const)("toggles a closable %s task", (status) => {
    const { checkbox, onChange } = renderTask(task({ status, canClose: true }));
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
        en: "Assigned to Karel Vondra. Only they, the recording's owner or a curator can mark it done.",
        cs: "Přiřazeno: Karel Vondra. Hotovo může označit jen přiřazená osoba, vlastník nahrávky nebo kurátor.",
    },
    {
        label: "an assignee without an email",
        overrides: { assigneeHasEmail: false },
        en: "Assigned to Karel Vondra, who has no email in the Almanac, so the task is on nobody's list.",
        cs: "Přiřazeno: Karel Vondra, ale tato osoba nemá v Almanachu e-mail, takže úkol nemá nikdo ve svém seznamu.",
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
] as const)("unavailable checkbox in %s", (language) => {
    it.each(
        cases,
    )("explains $label on hover and click without changing the task", async ({
        overrides,
        en,
        cs,
    }) => {
        locale.current = language;
        const value = task(overrides);
        const { checkbox, onChange } = renderTask(value);
        const reason = language === "en" ? en : cs;

        expect(checkbox).toHaveProperty("disabled", false);
        expect(checkbox.getAttribute("aria-disabled")).toBe("true");
        expect(
            checkbox.classList.contains("aria-disabled:cursor-not-allowed"),
        ).toBe(true);
        expect(checkbox.classList.contains("aria-disabled:opacity-50")).toBe(
            true,
        );
        const text = screen.getByText(value.text);
        expect(text.className).not.toMatch(/opacity|text-muted/);
        expect(text.closest("li")?.className).not.toMatch(/opacity|text-muted/);

        fireEvent.pointerMove(checkbox, { pointerType: "mouse" });
        expect((await screen.findByRole("tooltip")).textContent).toBe(reason);
        fireEvent.click(checkbox);
        expect(toastError).toHaveBeenCalledExactlyOnceWith(reason);
        expect(onChange).not.toHaveBeenCalled();
        expect(checkbox).toHaveProperty("checked", false);
        expect(value.status).toBe("open");
    });
});

it("explains an unavailable checkbox on Space while keeping it focused and unchanged", () => {
    const { checkbox, onChange } = renderTask(task());
    act(() => checkbox.focus());
    expect(document.activeElement).toBe(checkbox);
    expect(fireEvent.keyDown(checkbox, { key: " ", code: "Space" })).toBe(
        false,
    );
    fireEvent.keyUp(checkbox, { key: " ", code: "Space" });
    expect(toastError).toHaveBeenCalledExactlyOnceWith(cases[0]?.en);
    expect(onChange).not.toHaveBeenCalled();
    expect(checkbox).toHaveProperty("checked", false);
    expect(document.activeElement).toBe(checkbox);
});

it("leaves an unavailable completed task checked", () => {
    const { checkbox, onChange } = renderTask(task({ status: "done" }));
    fireEvent.click(checkbox);
    expect(checkbox).toHaveProperty("checked", true);
    expect(onChange).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledExactlyOnceWith(cases[0]?.en);
});

it.each([
    true,
    false,
])("keeps a dropped task plainly disabled with canClose=%s", (canClose) => {
    const { checkbox, onChange } = renderTask(
        task({ status: "dropped", canClose }),
    );
    expect(checkbox).toHaveProperty("disabled", true);
    expect(checkbox.hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(checkbox);
    expect(toastError).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("tooltip")).toBeNull();
});
