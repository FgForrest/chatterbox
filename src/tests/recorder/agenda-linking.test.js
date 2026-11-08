import { describe, expect, it } from "vitest";
import { shouldLinkEditedAgenda } from "../../../extensions/recorder/lib/agendas.js";

describe("first-edit agenda linking", () => {
    it.each([
        [null, false, true, true, true],
        [null, false, false, true, true],
        [null, false, false, false, false],
        ["other", false, true, true, true],
        ["other", true, false, true, false],
        ["other", true, true, true, false],
        ["other", false, false, true, false],
        ["agenda", true, true, true, false],
    ])("selection=%s own=%s editedOwn=%s editable=%s links=%s", (agendaId, agendaOwn, own, edit, expected) => {
        expect(
            shouldLinkEditedAgenda(
                { state: "recording", agendaId, agendaOwn },
                { id: "agenda", own, permissions: { edit } },
            ),
        ).toBe(expected);
    });
    it.each([
        "idle",
        "finalizing",
        "completed",
        "error",
    ])("never auto-links while %s", (state) => {
        expect(
            shouldLinkEditedAgenda(
                { state },
                { id: "agenda", own: true, permissions: { edit: true } },
            ),
        ).toBe(false);
    });
    it("never links stopped capture", () =>
        expect(
            shouldLinkEditedAgenda(
                { state: "recording", stopped: true },
                { id: "agenda", permissions: { edit: true } },
            ),
        ).toBe(false));
});

it("preserves explicit No agenda after unlinking when later notes are saved", () => {
    expect(
        shouldLinkEditedAgenda(
            { state: "recording", agendaId: null, agendaExplicit: true },
            { id: "agenda", own: true, permissions: { edit: true } },
        ),
    ).toBe(false);
});
