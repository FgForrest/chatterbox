import { writeFileSync } from "node:fs";
import { afterAll, expect, it, vi } from "vitest";
import { sqlClient } from "@/db";
import type * as CalendarEvents from "@/lib/integrations/google/calendar-events";
import { getMeeting } from "@/lib/meetings/service";
import { demoCalendarEvent, seedUserGuideDemo } from "./seed";

vi.mock(
    "@/lib/integrations/google/calendar-events",
    async (importOriginal) => ({
        ...(await importOriginal<typeof CalendarEvents>()),
        getCalendarEvent: async (_userId: string, eventId: string) => {
            const event = demoCalendarEvent(new Date());
            if (event.id !== eventId)
                throw new Error(`No demo Calendar event ${eventId}`);
            return event;
        },
    }),
);

const confirmed = process.env.USER_GUIDE_SEED === "wipe-this-database";

afterAll(async () => {
    await sqlClient?.end();
});

it.runIf(confirmed)(
    "seeds the user guide's demo data",
    async () => {
        const result = await seedUserGuideDemo();
        const out = process.env.USER_GUIDE_SEED_OUT;
        if (out) writeFileSync(out, JSON.stringify(result, null, 2));
        expect(result.audio.length).toBeGreaterThan(0);
        const meeting = await getMeeting(result.users.alex, result.meeting);
        expect(meeting.unchanged).toBe(false);
        if (meeting.unchanged) throw new Error("No demo meeting detail");
        expect(meeting.id).toBe(result.meeting);
        expect(meeting.state).toBe("planned");
        expect(meeting.taskSource?.id).toBe(result.recordings["product-sync"]);
        expect(meeting.invitees.map((invitee) => invitee.name)).toEqual([
            "Alex Morgan",
            "Priya Raman",
        ]);
        expect(meeting.tasks.length).toBeGreaterThanOrEqual(3);
        expect(meeting.tasks.some((task) => task.status === "done")).toBe(true);
        expect(
            meeting.taskGroups.some(
                (group) => !group.invited && group.tasks.length > 0,
            ),
        ).toBe(true);
        expect(meeting.points.filter((point) => !point.parentId)).toHaveLength(
            3,
        );
        expect(meeting.points.some((point) => point.parentId)).toBe(true);
    },
    120_000,
);
