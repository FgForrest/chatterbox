// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
    AGENDA_TEXT_NAME,
    agendaTextBase64,
    agendaTextBytes,
    createAgendaTextDoc,
} from "@/lib/meetings/text-model";
import {
    type AgendaTextState,
    bindAgendaTextInput,
} from "@/lib/meetings/text-sync";

const disposals: (() => void)[] = [];
afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
    document.body.replaceChildren();
});

function setup() {
    const server = createAgendaTextDoc("Planning");
    disposals.push(() => server.destroy());
    let version = 0;
    const state = (): AgendaTextState => ({
        field: "point:p:text",
        update: agendaTextBase64(Y.encodeStateAsUpdate(server)),
        stateVector: agendaTextBase64(Y.encodeStateVector(server)),
        version,
    });
    const get = vi.fn(async () => state());
    const send = vi.fn(
        async (body: {
            field: string;
            update: string;
            stateVector: string;
        }) => {
            Y.applyUpdate(server, agendaTextBytes(body.update));
            version++;
            return {
                ...state(),
                update: agendaTextBase64(
                    Y.encodeStateAsUpdate(
                        server,
                        agendaTextBytes(body.stateVector),
                    ),
                ),
            };
        },
    );
    const input = document.createElement("textarea");
    input.value = "Planning";
    document.body.append(input);
    const onError = vi.fn();
    const binding = bindAgendaTextInput(
        input,
        "point:p:text",
        { get, send },
        { onError, debounceMs: 10000 },
    );
    disposals.push(() => binding.destroy());
    return { server, state, get, send, input, binding, onError };
}

describe("framework-free agenda text input binding", () => {
    it("does not let an obsolete initialization change the read-only state of a replacement binding", async () => {
        const { input, get, state, binding } = setup();
        let finish: ((state: AgendaTextState) => void) | undefined;
        get.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        input.focus();
        expect(input.readOnly).toBe(true);
        binding.destroy();
        const replacement = bindAgendaTextInput(input, "point:p:text", {
            get: async () => state(),
            send: async () => state(),
        });
        disposals.push(() => replacement.destroy());
        await vi.waitFor(() => expect(input.readOnly).toBe(false));
        finish?.(state());
        await Promise.resolve();
        await Promise.resolve();
        expect(input.readOnly).toBe(false);
    });
    it("fetches the server seed before editing, debounces and sends minimal character changes", async () => {
        const { input, get, send, binding, server } = setup();
        expect(get).not.toHaveBeenCalled();
        input.focus();
        await vi.waitFor(() => expect(input.readOnly).toBe(false));
        expect(get).toHaveBeenCalledOnce();
        input.value = "Planning today";
        input.dispatchEvent(new Event("input"));
        expect(send).not.toHaveBeenCalled();
        expect(await binding.flush()).toBe(true);
        expect(server.getText(AGENDA_TEXT_NAME).toString()).toBe(
            "Planning today",
        );
        expect(send).toHaveBeenCalledOnce();
    });
    it("applies remote changes with a relative-position caret and preserves input scroll", async () => {
        const { input, server, binding } = setup();
        input.focus();
        await vi.waitFor(() => expect(input.readOnly).toBe(false));
        input.setSelectionRange(4, 6, "backward");
        input.scrollTop = 30;
        server.getText(AGENDA_TEXT_NAME).insert(0, "A ");
        await binding.resync();
        expect(input.value).toBe("A Planning");
        expect(input.selectionStart).toBe(6);
        expect(input.selectionEnd).toBe(8);
        expect(input.selectionDirection).toBe("backward");
        expect(input.scrollTop).toBe(30);
        expect(document.activeElement).toBe(input);
    });
    it("retains unsent edits through failure and merges remote state on reconnect", async () => {
        const { input, server, binding, send, onError } = setup();
        input.focus();
        await vi.waitFor(() => expect(input.readOnly).toBe(false));
        input.value = "Planning local";
        input.dispatchEvent(new Event("input"));
        send.mockRejectedValueOnce(new Error("Disconnected"));
        expect(await binding.flush()).toBe(false);
        expect(onError).toHaveBeenCalledOnce();
        server.getText(AGENDA_TEXT_NAME).insert(0, "Remote ");
        await binding.resync();
        expect(server.getText(AGENDA_TEXT_NAME).toString()).toBe(
            "Remote Planning local",
        );
        expect(input.value).toBe("Remote Planning local");
    });
    it("does not replace an in-progress IME composition with remote text", async () => {
        const { input, server, binding } = setup();
        input.focus();
        await vi.waitFor(() => expect(input.readOnly).toBe(false));
        input.dispatchEvent(new Event("compositionstart"));
        input.value = "Planning č";
        input.dispatchEvent(new Event("input"));
        server.getText(AGENDA_TEXT_NAME).insert(0, "Remote ");
        await binding.resync();
        expect(input.value).toBe("Planning č");
        input.dispatchEvent(new Event("compositionend"));
        await binding.flush();
        expect(input.value).toBe("Remote Planning č");
        expect(server.getText(AGENDA_TEXT_NAME).toString()).toBe(
            "Remote Planning č",
        );
    });
});
