// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type { TranslationValues } from "use-intl";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { OutlineEditor } from "@/components/meetings/outline-editor";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import {
    agendaTextBase64,
    createAgendaTextDoc,
} from "@/lib/meetings/text-model";
import { detail, point } from "./ui-fixtures";

vi.mock("next-intl", () => ({
    useExtracted: () => (text: string, values?: TranslationValues) =>
        translatedSourceMessage("en", text, values),
    useFormatter: () => ({
        dateTime: (value: Date) => value.toISOString().slice(11, 16),
    }),
}));
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

it.each(
    [
        "Indent point",
        "Outdent point",
        "Remove point",
        "Discussed: Planning",
    ].flatMap((action) =>
        ["text", "note"].flatMap((field) =>
            [true, false].map((saved) => ({ action, field, saved })),
        ),
    ),
)("flushes $field before mouse $action (saved=$saved)", async ({
    action,
    field,
    saved,
}) => {
    const doc = createAgendaTextDoc("Planning");
    let finish: (() => void) | undefined;
    const state = () => ({
        field: `point:p:${field}`,
        update: agendaTextBase64(Y.encodeStateAsUpdate(doc)),
        stateVector: agendaTextBase64(Y.encodeStateVector(doc)),
        version: 0,
        materializedVersion: 3,
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST")
            return new Promise((resolve) => {
                finish = () =>
                    resolve(
                        saved
                            ? Response.json({
                                  ...state(),
                                  materializedVersion: 4,
                              })
                            : Response.json(
                                  { error: "offline" },
                                  { status: 503 },
                              ),
                    );
            });
        return Response.json(state());
    });
    vi.stubGlobal("fetch", fetchMock);
    const onPatch = vi.fn().mockResolvedValue(true);
    const onRemove = vi.fn();
    const view = render(
        <OutlineEditor
            detail={detail({
                textProtocol: 1,
                points: [
                    point("previous"),
                    point("p", {
                        text: "Planning",
                        position: 1,
                        version: 3,
                        parentId:
                            action === "Outdent point" ? "previous" : null,
                    }),
                ],
            })}
            live
            userId="owner"
            onPatch={onPatch}
            onRemove={onRemove}
            onAdd={vi.fn().mockResolvedValue(true)}
        />,
    );
    const input = screen.getAllByRole("textbox", {
        name: field === "text" ? "Discussion point" : "Point note",
    })[1] as HTMLTextAreaElement;
    input.focus();
    await waitFor(() => expect(input.readOnly).toBe(false));
    fireEvent.input(input, { target: { value: "Planning local" } });
    input.blur();
    await waitFor(() => expect(finish).toBeDefined());
    fireEvent.click(
        screen
            .getAllByRole(
                action.startsWith("Discussed") ? "checkbox" : "button",
                { name: action },
            )
            .at(-1) as HTMLElement,
    );
    expect(onPatch).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
    await act(async () => {
        finish?.();
    });
    if (saved) {
        await waitFor(() =>
            expect(
                action === "Remove point" ? onRemove : onPatch,
            ).toHaveBeenCalledWith(
                expect.objectContaining({ id: "p", version: 4 }),
                ...(action === "Remove point" ? [] : [expect.any(Object)]),
            ),
        );
    } else {
        expect(onPatch).not.toHaveBeenCalled();
        expect(onRemove).not.toHaveBeenCalled();
    }
    view.unmount();
    doc.destroy();
});
