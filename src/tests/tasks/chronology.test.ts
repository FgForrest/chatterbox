import { describe, expect, it } from "vitest";
import type { ContentSegment } from "@/lib/content/types";
import {
    fieldProposalIsLater,
    statementTimeForSegment,
} from "@/lib/tasks/chronology";

const ITEM_AT = new Date("2026-10-08T11:00:00.000Z");

function quoted(at: Date | null): ContentSegment {
    return {
        index: 2,
        role: "quoted",
        participantRef: "p2",
        depth: 1,
        at,
        text: "Earlier words",
    };
}

describe("task chronology", () => {
    it("uses only a plausible claimed date for a quoted part", () => {
        expect(statementTimeForSegment(ITEM_AT, quoted(null))).toEqual(ITEM_AT);
        expect(
            statementTimeForSegment(
                ITEM_AT,
                quoted(new Date("2026-10-09T09:00:00.000Z")),
            ),
        ).toEqual(ITEM_AT);
        expect(
            statementTimeForSegment(ITEM_AT, quoted(new Date("not a date"))),
        ).toEqual(ITEM_AT);
        expect(
            statementTimeForSegment(
                ITEM_AT,
                quoted(new Date("2026-10-07T09:00:00.000Z")),
            ),
        ).toEqual(new Date("2026-10-07T09:00:00.000Z"));
    });

    it("uses the item time for the item's own content", () => {
        expect(
            statementTimeForSegment(ITEM_AT, {
                ...quoted(new Date("2026-10-07T09:00:00.000Z")),
                role: "body",
                depth: 0,
            }),
        ).toEqual(ITEM_AT);
    });

    it("offers a field change only after that field's effective time", () => {
        const statement = new Date("2026-10-08T09:00:00.000Z");
        expect(fieldProposalIsLater(statement, null)).toBe(true);
        expect(
            fieldProposalIsLater(
                statement,
                new Date("2026-10-08T08:00:00.000Z"),
            ),
        ).toBe(true);
        expect(fieldProposalIsLater(statement, new Date(statement))).toBe(
            false,
        );
        expect(
            fieldProposalIsLater(
                statement,
                new Date("2026-10-08T10:00:00.000Z"),
            ),
        ).toBe(false);
    });
});
