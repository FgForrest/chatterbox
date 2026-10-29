// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SummaryEditor } from "@/components/summary/summary-editor";

vi.mock("next-intl", () => ({
    useExtracted: () => (message: string) => message,
}));

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function editor(
    onSave = vi.fn().mockResolvedValue(true),
    keyPoints = ["First point", "Second point"],
) {
    return render(
        <SummaryEditor
            summary="Summary prose"
            keyPoints={keyPoints}
            onSave={onSave}
            onCancel={vi.fn()}
        />,
    );
}

describe("summary editor key points", () => {
    it("opens with a list marker on each stored point and the list hint", () => {
        editor();
        expect(
            screen.getByRole<HTMLTextAreaElement>("textbox", {
                name: /Key Points/,
            }).value,
        ).toBe("- First point\n- Second point");
        expect(screen.getByText("one per line, starting with -")).toBeTruthy();
    });

    it.each([
        "- One\n\n- Two",
        "One\nTwo",
    ])("saves %s as separate points without markers", async (draft) => {
        const onSave = vi.fn().mockResolvedValue(true);
        editor(onSave);
        fireEvent.change(screen.getByRole("textbox", { name: /Key Points/ }), {
            target: { value: draft },
        });
        await act(async () =>
            fireEvent.click(screen.getByRole("button", { name: "Save" })),
        );
        expect(onSave).toHaveBeenCalledExactlyOnceWith("Summary prose", [
            "One",
            "Two",
        ]);
    });

    it("preserves stored leading markers when saving an unchanged draft", async () => {
        const onSave = vi.fn().mockResolvedValue(true);
        const points = ["- First point", "* Second point", "• Third point"];
        editor(onSave, points);
        expect(
            screen.getByRole<HTMLTextAreaElement>("textbox", {
                name: /Key Points/,
            }).value,
        ).toBe("- - First point\n- * Second point\n- • Third point");
        await act(async () =>
            fireEvent.click(screen.getByRole("button", { name: "Save" })),
        );
        expect(onSave).toHaveBeenCalledExactlyOnceWith("Summary prose", points);
    });
});

const fields = [
    { name: /Summary text/, minimum: "min-h-64", maximum: "max-h-[70vh]" },
    { name: /Key Points/, minimum: "min-h-36", maximum: "max-h-[50vh]" },
];

describe("summary editor sizing", () => {
    it.each([
        120, 2000,
    ])("sizes both fields to scrollHeight %i on mount with CSS bounds and proportional text", (height) => {
        vi.spyOn(
            HTMLTextAreaElement.prototype,
            "scrollHeight",
            "get",
        ).mockReturnValue(height);
        editor();

        for (const { name, minimum, maximum } of fields) {
            const field = screen.getByRole("textbox", { name });
            expect(field.style.height).toBe(`${height}px`);
            expect(field.classList.contains("font-mono")).toBe(false);
            for (const className of [
                "text-base",
                "md:text-sm",
                "leading-6",
                "resize-none",
                "overflow-y-auto",
                minimum,
                maximum,
            ])
                expect(field.classList.contains(className)).toBe(true);
            expect(field.getAttribute("data-slot")).toBe("textarea");
        }
    });

    it.each(fields)("grows and shrinks $name after typing", ({ name }) => {
        const scrollHeight = vi
            .spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
            .mockReturnValue(300);
        editor();
        const field = screen.getByRole("textbox", { name });
        expect(field.style.height).toBe("300px");

        scrollHeight.mockReturnValue(600);
        fireEvent.change(field, { target: { value: "Longer draft" } });
        expect(field.style.height).toBe("600px");

        scrollHeight.mockReturnValue(120);
        fireEvent.change(field, { target: { value: "Short draft" } });
        expect(field.style.height).toBe("120px");
    });

    it("includes borders so content fits the border-box height", () => {
        vi.spyOn(
            HTMLTextAreaElement.prototype,
            "scrollHeight",
            "get",
        ).mockReturnValue(300);
        vi.spyOn(
            HTMLTextAreaElement.prototype,
            "offsetHeight",
            "get",
        ).mockReturnValue(302);
        vi.spyOn(
            HTMLTextAreaElement.prototype,
            "clientHeight",
            "get",
        ).mockReturnValue(300);
        editor();
        for (const { name } of fields)
            expect(screen.getByRole("textbox", { name }).style.height).toBe(
                "302px",
            );
    });

    it("remeasures on width changes and disconnects observers on unmount", () => {
        const observers: {
            resize: () => void;
            observe: ReturnType<typeof vi.fn>;
            disconnect: ReturnType<typeof vi.fn>;
        }[] = [];
        vi.stubGlobal(
            "ResizeObserver",
            class {
                observe = vi.fn();
                disconnect = vi.fn();
                constructor(resize: () => void) {
                    observers.push({
                        resize,
                        observe: this.observe,
                        disconnect: this.disconnect,
                    });
                }
            },
        );
        const scrollHeight = vi
            .spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
            .mockReturnValue(300);
        const clientWidth = vi
            .spyOn(HTMLTextAreaElement.prototype, "clientWidth", "get")
            .mockReturnValue(800);
        const { unmount } = editor();
        expect(observers).toHaveLength(2);
        for (const [index, { name }] of fields.entries())
            expect(observers[index].observe).toHaveBeenCalledWith(
                screen.getByRole("textbox", { name }),
            );

        scrollHeight.mockReturnValue(600);
        act(() => {
            for (const { resize } of observers) resize();
        });
        for (const { name } of fields)
            expect(screen.getByRole("textbox", { name }).style.height).toBe(
                "300px",
            );

        clientWidth.mockReturnValue(400);
        act(() => {
            for (const { resize } of observers) resize();
        });
        for (const { name } of fields)
            expect(screen.getByRole("textbox", { name }).style.height).toBe(
                "600px",
            );

        unmount();
        for (const { disconnect } of observers)
            expect(disconnect).toHaveBeenCalledOnce();
    });

    it("mounts and remeasures after typing without ResizeObserver", () => {
        vi.stubGlobal("ResizeObserver", undefined);
        const scrollHeight = vi
            .spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
            .mockReturnValue(300);
        editor();
        for (const { name } of fields) {
            const field = screen.getByRole("textbox", { name });
            expect(field.style.height).toBe("300px");
            scrollHeight.mockReturnValue(600);
            fireEvent.change(field, { target: { value: "Updated draft" } });
            expect(field.style.height).toBe("600px");
            scrollHeight.mockReturnValue(300);
        }
    });
});
