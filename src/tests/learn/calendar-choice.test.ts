import { describe, expect, it } from "vitest";
import { calendarChoiceFor } from "@/components/learn/calendar-choice";

const first = { id: "event-1", title: "Team", start: "2026-10-07T10:00:00Z" };
const second = {
    id: "event-2",
    title: "Client",
    start: "2026-10-07T10:15:00Z",
};

describe("Calendar choice before Learn", () => {
    it("runs Learn without Calendar when no event matches", () => {
        expect(calendarChoiceFor([])).toEqual({ kind: "none" });
    });
    it("uses a single matching event", () => {
        expect(calendarChoiceFor([first])).toEqual({
            kind: "one",
            eventId: "event-1",
        });
    });
    it("requires a choice when meetings overlap", () => {
        expect(calendarChoiceFor([first, second])).toEqual({
            kind: "choose",
            events: [first, second],
        });
    });
});
