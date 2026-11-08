import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
    AGENDA_TEXT_NAME,
    agendaTextBase64,
    agendaTextBytes,
    createAgendaTextDoc,
    editAgendaText,
    materializeAgendaText,
} from "@/lib/meetings/text-model";

describe("agenda text CRDT", () => {
    it("merges two first editors of the same server seed without duplicating it", () => {
        const server = createAgendaTextDoc("Planning");
        const seed = Y.encodeStateAsUpdate(server);
        const clients = [new Y.Doc(), new Y.Doc()];
        for (const client of clients) Y.applyUpdate(client, seed);
        clients[0].getText(AGENDA_TEXT_NAME).insert(0, "A ");
        clients[1].getText(AGENDA_TEXT_NAME).insert(8, " B");
        for (const client of clients)
            Y.applyUpdate(server, Y.encodeStateAsUpdate(client));
        expect(materializeAgendaText(server, true)).toBe("A Planning B");
        for (const client of clients) {
            Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
            expect(client.getText(AGENDA_TEXT_NAME).toString()).toBe(
                "A Planning B",
            );
        }
        for (const doc of clients) doc.destroy();
        server.destroy();
    });

    it("preserves unchanged character identities in minimal local edits", () => {
        const doc = createAgendaTextDoc("Before after");
        const text = doc.getText(AGENDA_TEXT_NAME);
        const caret = Y.createRelativePositionFromTypeIndex(text, 12);
        editAgendaText(text, "Before middle after");
        expect(
            Y.createAbsolutePositionFromRelativePosition(caret, doc)?.index,
        ).toBe(19);
        expect(text.toString()).toBe("Before middle after");
        doc.destroy();
    });

    it("serializes state bytes canonically and enforces bounds", () => {
        const bytes = new Uint8Array([0, 1, 200, 255]);
        expect(agendaTextBytes(agendaTextBase64(bytes))).toEqual(bytes);
        expect(() => agendaTextBytes("not base64")).toThrow();
        expect(() => agendaTextBytes(agendaTextBase64(bytes), 2)).toThrow();
    });
    it("does not split surrogate pairs while replacing Unicode characters", () => {
        const doc = createAgendaTextDoc("A 😀 B");
        const text = doc.getText(AGENDA_TEXT_NAME);
        editAgendaText(text, "A 😃 B");
        expect(text.toString()).toBe("A 😃 B");
        doc.destroy();
    });

    it.each([
        "\n",
        "\r",
        "x".repeat(2001),
        " ",
    ])("refuses invalid required text", (value) => {
        const doc = createAgendaTextDoc(value);
        expect(() => materializeAgendaText(doc, true)).toThrow();
        doc.destroy();
    });

    it("allows an empty note and rejects formatting, embeds and other roots", () => {
        const note = createAgendaTextDoc("");
        expect(materializeAgendaText(note, false)).toBe("");
        note.getText(AGENDA_TEXT_NAME).insert(0, "Note", { bold: true });
        expect(() => materializeAgendaText(note, false)).toThrow();
        const foreign = createAgendaTextDoc("Text");
        foreign.getMap("other").set("key", "value");
        expect(() => materializeAgendaText(foreign, false)).toThrow();
        const embedded = createAgendaTextDoc("");
        embedded.getText(AGENDA_TEXT_NAME).insertEmbed(0, { image: "value" });
        expect(() => materializeAgendaText(embedded, false)).toThrow();
        for (const doc of [note, foreign, embedded]) doc.destroy();
    });
});
