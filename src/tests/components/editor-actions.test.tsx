// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FormEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorActions } from "@/components/ui/editor-actions";

afterEach(cleanup);

describe("EditorActions", () => {
    it("shows the supplied hint and labels with small shared buttons", () => {
        render(
            <EditorActions
                hint="Visible to everyone who sees this task."
                cancelLabel="Skip"
                saveLabel="Save note"
                onCancel={vi.fn()}
                onSave={vi.fn()}
            />,
        );
        expect(
            screen
                .getByText("Visible to everyone who sees this task.")
                .classList.contains("max-w-md"),
        ).toBe(true);
        for (const label of ["Skip", "Save note"]) {
            const button = screen.getByRole<HTMLButtonElement>("button", {
                name: label,
            });
            expect(button.dataset.slot).toBe("button");
            expect(button.classList.contains("h-8")).toBe(true);
        }
        expect(
            screen
                .getByRole("button", { name: "Skip" })
                .classList.contains("border"),
        ).toBe(true);
    });

    it("calls cancel and save separately without submitting a surrounding form", () => {
        const onCancel = vi.fn();
        const onSave = vi.fn();
        const submit = vi.fn((event: FormEvent<HTMLFormElement>) =>
            event.preventDefault(),
        );
        render(
            <form onSubmit={submit}>
                <EditorActions
                    cancelLabel="Skip"
                    saveLabel="Save note"
                    onCancel={onCancel}
                    onSave={onSave}
                />
            </form>,
        );
        fireEvent.click(screen.getByRole("button", { name: "Skip" }));
        expect(onCancel).toHaveBeenCalledOnce();
        expect(onSave).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Save note" }));
        expect(onSave).toHaveBeenCalledOnce();
        expect(submit).not.toHaveBeenCalled();
    });

    it("submits the surrounding form when type is submit", () => {
        const submit = vi.fn((event: FormEvent<HTMLFormElement>) =>
            event.preventDefault(),
        );
        render(
            <form onSubmit={submit}>
                <EditorActions
                    cancelLabel="Cancel"
                    saveLabel="Save"
                    type="submit"
                    onCancel={vi.fn()}
                />
            </form>,
        );
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(submit).toHaveBeenCalledOnce();
    });

    it("disables both actions while saving", () => {
        const onCancel = vi.fn();
        const onSave = vi.fn();
        render(
            <EditorActions
                cancelLabel="Cancel"
                saveLabel="Saving…"
                saving
                onCancel={onCancel}
                onSave={onSave}
            />,
        );
        for (const button of screen.getAllByRole<HTMLButtonElement>("button")) {
            expect(button.disabled).toBe(true);
            fireEvent.click(button);
        }
        expect(onCancel).not.toHaveBeenCalled();
        expect(onSave).not.toHaveBeenCalled();
    });

    it("can disable saving alone and omit the hint", () => {
        const onCancel = vi.fn();
        const view = render(
            <EditorActions
                cancelLabel="Cancel"
                saveLabel="Save"
                saveDisabled
                onCancel={onCancel}
                onSave={vi.fn()}
            />,
        );
        expect(
            screen.getByRole<HTMLButtonElement>("button", { name: "Save" })
                .disabled,
        ).toBe(true);
        expect(
            screen.getByRole<HTMLButtonElement>("button", { name: "Cancel" })
                .disabled,
        ).toBe(false);
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onCancel).toHaveBeenCalledOnce();
        expect(view.container.querySelector("p")).toBeNull();
    });
});
