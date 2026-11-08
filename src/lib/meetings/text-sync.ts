import * as Y from "yjs";
import {
    AGENDA_TEXT_NAME,
    agendaTextBase64,
    agendaTextBytes,
    editAgendaText,
    MAX_AGENDA_TEXT_STATE_BYTES,
} from "./text-model";

export interface AgendaTextState {
    field: string;
    update: string;
    stateVector: string;
    version: number;
    materializedVersion?: number;
}

export interface AgendaTextTransport {
    get: (field: string) => Promise<AgendaTextState>;
    send: (input: {
        field: string;
        update: string;
        stateVector: string;
    }) => Promise<AgendaTextState>;
}

/** Bind one input to the server-seeded Y.Text, with serialized retries and relative-position carets. */
export function bindAgendaTextInput(
    input: HTMLInputElement | HTMLTextAreaElement,
    field: string,
    transport: AgendaTextTransport,
    options: {
        onValue?: (value: string) => void;
        onSaved?: () => void;
        onError?: () => void;
        debounceMs?: number;
    } = {},
) {
    const doc = new Y.Doc();
    const text = doc.getText(AGENDA_TEXT_NAME);
    let initialized = false;
    let connecting: Promise<void> | null = null;
    let sending: Promise<boolean> | null = null;
    let serverVector: Uint8Array | undefined;
    let materializedVersion: number | undefined;
    let edits = 0;
    let acknowledged = 0;
    let disposed = false;
    let composing = false;
    let localBlank = false;
    let refused = false;
    let retryDelay = 2000;
    let deferred: AgendaTextState | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const originalReadOnly = input.readOnly;
    const required = /^point:[^:]+:text$/u.test(field);

    function errorStatus(error: unknown) {
        return error &&
            typeof error === "object" &&
            "status" in error &&
            typeof error.status === "number"
            ? error.status
            : undefined;
    }

    function renderRemote(state: AgendaTextState) {
        if (composing) {
            deferred = state;
            return;
        }
        const focused = input.ownerDocument.activeElement === input;
        const start =
            initialized && focused
                ? Y.createRelativePositionFromTypeIndex(
                      text,
                      input.selectionStart ?? 0,
                  )
                : null;
        const end =
            initialized && focused
                ? Y.createRelativePositionFromTypeIndex(
                      text,
                      input.selectionEnd ?? 0,
                  )
                : null;
        const direction = input.selectionDirection ?? "none";
        const top = input.scrollTop;
        const left = input.scrollLeft;
        Y.applyUpdate(
            doc,
            agendaTextBytes(state.update, MAX_AGENDA_TEXT_STATE_BYTES),
        );
        serverVector = agendaTextBytes(state.stateVector, 8192);
        if (state.materializedVersion !== undefined)
            materializedVersion = Math.max(
                materializedVersion ?? 0,
                state.materializedVersion,
            );
        initialized = true;
        if (localBlank && focused) return;
        localBlank = false;
        input.value = text.toString();
        options.onValue?.(input.value);
        if (start && end) {
            const a = Y.createAbsolutePositionFromRelativePosition(start, doc);
            const b = Y.createAbsolutePositionFromRelativePosition(end, doc);
            if (a && b) input.setSelectionRange(a.index, b.index, direction);
        }
        input.scrollTop = top;
        input.scrollLeft = left;
    }

    async function connect() {
        if (disposed) return;
        if (connecting) return connecting;
        if (!initialized) input.readOnly = true;
        connecting = transport
            .get(field)
            .then((state) => {
                if (!disposed) renderRemote(state);
            })
            .catch((error: unknown) => {
                if (!disposed) options.onError?.();
                throw error;
            })
            .finally(() => {
                if (!disposed)
                    input.readOnly = initialized ? originalReadOnly : true;
                connecting = null;
            });
        return connecting;
    }

    function schedule(delay = options.debounceMs ?? 250) {
        clearTimeout(timer);
        if (!disposed)
            timer = setTimeout(() => {
                void flush();
            }, delay);
    }

    async function flush(): Promise<boolean> {
        clearTimeout(timer);
        if (connecting) {
            try {
                await connecting;
            } catch {
                return false;
            }
        }
        if (refused) return false;
        if (!initialized || edits === acknowledged || composing) return true;
        if (sending) {
            const saved = await sending;
            return saved && edits !== acknowledged ? flush() : saved;
        }
        const sentEdits = edits;
        const send = () =>
            transport.send({
                field,
                update: agendaTextBase64(
                    Y.encodeStateAsUpdate(doc, serverVector),
                ),
                stateVector: agendaTextBase64(Y.encodeStateVector(doc)),
            });
        sending = send()
            .catch(async (error: unknown) => {
                if (errorStatus(error) !== 409 || disposed) throw error;
                const state = await transport.get(field);
                if (disposed) throw error;
                renderRemote(state);
                return send();
            })
            .then((state) => {
                if (!disposed) renderRemote(state);
                acknowledged = sentEdits;
                retryDelay = 2000;
                options.onSaved?.();
                return true;
            })
            .catch((error: unknown) => {
                options.onError?.();
                const status = errorStatus(error);
                if (
                    status === undefined ||
                    status === 429 ||
                    (status >= 500 && status < 600)
                ) {
                    schedule(retryDelay);
                    retryDelay = Math.min(retryDelay * 2, 30000);
                } else {
                    refused = true;
                    clearTimeout(timer);
                }
                return false;
            })
            .finally(() => {
                sending = null;
            });
        const saved = await sending;
        if (saved && edits !== acknowledged) return flush();
        return saved;
    }

    function localInput() {
        if (!initialized || composing || disposed) return;
        const value = input.value.replace(/[\r\n]/gu, " ");
        localBlank = required && !value.trim();
        if (localBlank) return;
        refused = false;
        editAgendaText(text, value);
        edits++;
        schedule();
    }
    function focus() {
        void connect()
            .then(() => flush())
            .catch(() => {});
    }
    function blur() {
        if (localBlank) {
            localBlank = false;
            input.value = text.toString();
            options.onValue?.(input.value);
        }
        void flush();
    }
    function compositionStart() {
        composing = true;
    }
    function compositionEnd() {
        composing = false;
        localInput();
        if (deferred) {
            const state = deferred;
            deferred = null;
            renderRemote(state);
        }
    }
    input.addEventListener("focus", focus);
    input.addEventListener("input", localInput);
    input.addEventListener("blur", blur);
    input.addEventListener("compositionstart", compositionStart);
    input.addEventListener("compositionend", compositionEnd);
    const window = input.ownerDocument.defaultView;
    window?.addEventListener("online", focus);
    if (input.ownerDocument.activeElement === input) focus();
    return {
        flush,
        materializedVersion: () => materializedVersion,
        resync: () =>
            initialized ? connect().then(() => flush()) : Promise.resolve(true),
        destroy() {
            if (disposed) return;
            input.removeEventListener("focus", focus);
            input.removeEventListener("input", localInput);
            input.removeEventListener("blur", blur);
            input.removeEventListener("compositionstart", compositionStart);
            input.removeEventListener("compositionend", compositionEnd);
            window?.removeEventListener("online", focus);
            clearTimeout(timer);
            const pending = flush();
            disposed = true;
            input.readOnly = originalReadOnly;
            void pending.finally(() => doc.destroy());
        },
    };
}
