export interface CalendarChoice {
    id: string;
    title: string;
    start: string;
}

/** One event may be used directly; multiple require the owner's choice. */
export function calendarChoiceFor(
    events: readonly CalendarChoice[],
):
    | { kind: "none" }
    | { kind: "one"; eventId: string }
    | { kind: "choose"; events: readonly CalendarChoice[] } {
    if (events.length === 0) return { kind: "none" };
    if (events.length === 1) return { kind: "one", eventId: events[0].id };
    return { kind: "choose", events };
}
