import * as Y from "yjs";

export const AGENDA_TEXT_NAME = "text";
export const MAX_AGENDA_TEXT_UPDATE_BYTES = 64 * 1024;
export const MAX_AGENDA_TEXT_STATE_BYTES = 1024 * 1024;

/** Apply a minimal contiguous edit so unchanged characters retain their CRDT identity. */
export function editAgendaText(text: Y.Text, next: string) {
    const previous = text.toString();
    if (previous === next) return;
    let start = 0;
    while (
        start < previous.length &&
        start < next.length &&
        previous[start] === next[start]
    )
        start++;
    if (start > 0 && /[\uD800-\uDBFF]/u.test(previous[start - 1])) start--;
    let end = 0;
    while (
        end < previous.length - start &&
        end < next.length - start &&
        previous[previous.length - end - 1] === next[next.length - end - 1]
    )
        end++;
    if (end > 0 && /[\uDC00-\uDFFF]/u.test(previous[previous.length - end]))
        end--;
    text.doc?.transact(() => {
        const removed = previous.length - start - end;
        if (removed) text.delete(start, removed);
        const inserted = next.slice(start, next.length - end);
        if (inserted) text.insert(start, inserted);
    });
}

/** Seed only on the server, under the agenda lock, before returning the first document. */
export function createAgendaTextDoc(value: string): Y.Doc {
    const doc = new Y.Doc();
    doc.getText(AGENDA_TEXT_NAME).insert(0, value);
    return doc;
}

/** Reject nested data, formatting, unresolved updates and non-text roots. */
export function materializeAgendaText(doc: Y.Doc, required: boolean): string {
    const text = doc.getText(AGENDA_TEXT_NAME);
    const delta: { insert?: unknown; attributes?: unknown }[] = text.toDelta();
    const value = text.toString();
    if (
        doc.share.size !== 1 ||
        doc.store.pendingStructs ||
        doc.store.pendingDs ||
        delta.some(
            (part) =>
                typeof part.insert !== "string" ||
                part.attributes !== undefined,
        ) ||
        (text.getAttributes && Object.keys(text.getAttributes()).length > 0) ||
        value.length > 2000 ||
        /[\r\n]/u.test(value) ||
        (required && !value.trim())
    )
        throw new Error("Invalid agenda text document");
    return value;
}

/** Encode binary updates without a Node dependency, shared by the web and extension bundles. */
export function agendaTextBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

/** Decode a bounded, canonical base64 update. */
export function agendaTextBytes(
    value: string,
    maxBytes = MAX_AGENDA_TEXT_UPDATE_BYTES,
): Uint8Array {
    if (
        !value ||
        value.length > Math.ceil(maxBytes / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            value,
        )
    )
        throw new Error("Invalid agenda text encoding");
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    if (bytes.length > maxBytes)
        throw new Error("Agenda text update too large");
    return bytes;
}
