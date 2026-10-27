import type { agendaCandidates } from "@/lib/meetings/attachment";
import type {
    meetingCalendarEvents,
    nextMeeting,
} from "@/lib/meetings/calendar";
import type {
    getMeeting,
    listMeetings,
    olderTasks,
} from "@/lib/meetings/service";

type Json<T> = T extends Date
    ? string
    : T extends readonly (infer U)[]
      ? Json<U>[]
      : T extends object
        ? { [K in keyof T]: Json<T[K]> }
        : T;
type OptionalJob<T> = T extends { job: infer J }
    ? Omit<T, "job"> & { job?: J }
    : T;
type Detail = Json<
    Exclude<Awaited<ReturnType<typeof getMeeting>>, { unchanged: true }>
>;
export type MeetingDetail = Omit<Detail, "cursor" | "aiSuggestions"> & {
    cursor?: string;
    aiSuggestions: OptionalJob<Detail["aiSuggestions"]>;
};
export type MeetingPoint = MeetingDetail["points"][number];
export type MeetingTask = MeetingDetail["tasks"][number];
export type MeetingRowData = Json<
    Awaited<ReturnType<typeof listMeetings>>[number]
>;
export type CalendarChoices = Json<
    Awaited<ReturnType<typeof meetingCalendarEvents>>
>;
export type AgendaCandidate = Json<
    Awaited<ReturnType<typeof agendaCandidates>>[number]
>;
export type NextMeeting = Json<Awaited<ReturnType<typeof nextMeeting>>>;
export type OlderTask = Json<Awaited<ReturnType<typeof olderTasks>>[number]>;
