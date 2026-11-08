// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
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
import { detail, point } from "../meetings/ui-fixtures";

vi.mock("next-intl", () => ({
    useExtracted: () => (text: string, values?: TranslationValues) =>
        translatedSourceMessage("en", text, values),
    useFormatter: () => ({ dateTime: () => "" }),
}));

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

it("restores the current shared document on blank blur without React replacing it with a stale point prop", async () => {
    const doc = createAgendaTextDoc("Current shared text");
    const fetcher = vi.fn(async () =>
        Response.json({
            field: "point:Root:text",
            update: agendaTextBase64(Y.encodeStateAsUpdate(doc)),
            stateVector: agendaTextBase64(Y.encodeStateVector(doc)),
            version: 1,
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    render(
        <OutlineEditor
            detail={detail({ textProtocol: 1, points: [point("Root")] })}
            userId="owner"
            onPatch={vi.fn()}
            onRemove={vi.fn()}
            onAdd={vi.fn().mockResolvedValue(true)}
        />,
    );
    const input =
        screen.getByLabelText<HTMLTextAreaElement>("Discussion point");
    await act(async () => input.focus());
    expect(input.value).toBe("Current shared text");
    fireEvent.input(input, { target: { value: "" } });
    expect(input.value).toBe("");
    await act(async () => input.blur());
    expect(input.value).toBe("Current shared text");
    expect(fetcher).toHaveBeenCalledOnce();
    cleanup();
    doc.destroy();
});
