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
export type MeetingDetail = Omit<
    Detail,
    | "cursor"
    | "aiSuggestions"
    | "suggestionTasks"
    | "folderRecordingIds"
    | "shared"
    | "receivedShare"
    | "receivedFolders"
    | "agendaTitle"
    | "textProtocol"
    | "recordingBy"
    | "points"
    | "tasks"
> & {
    textProtocol?: number;
    recordingBy?: Detail["recordingBy"];
    points: (Omit<Detail["points"][number], "updatedByUserId"> & {
        updatedByUserId?: string | null;
    })[];
    tasks: (Omit<
        Detail["tasks"][number],
        | "agendaVersion"
        | "agendaUpdatedAt"
        | "agendaUpdatedByUserId"
        | "statusChangedByUserId"
    > & {
        agendaVersion?: number;
        agendaUpdatedAt?: string;
        agendaUpdatedByUserId?: string | null;
        statusChangedByUserId?: string | null;
    })[];
    cursor?: string;
    agendaTitle?: string;
    shared?: Detail["shared"];
    receivedShare?: Detail["receivedShare"];
    receivedFolders?: Detail["receivedFolders"];
    suggestionTasks?: Detail["suggestionTasks"];
    folderRecordingIds?: string[];
    aiSuggestions: OptionalJob<Detail["aiSuggestions"]>;
};
export type MeetingPoint = MeetingDetail["points"][number];
export type MeetingTask = MeetingDetail["tasks"][number];
type MeetingRow = Json<Awaited<ReturnType<typeof listMeetings>>[number]>;
export type MeetingRowData = Omit<
    MeetingRow,
    "received" | "recorded" | "own"
> & {
    own?: boolean;
    received?: boolean;
    recorded?: boolean;
};
export type CalendarChoices = Json<
    Awaited<ReturnType<typeof meetingCalendarEvents>>
>;
export type AgendaCandidate = Json<
    Awaited<ReturnType<typeof agendaCandidates>>[number]
>;
export type NextMeeting = Json<Awaited<ReturnType<typeof nextMeeting>>>;
export type OlderTask = Json<Awaited<ReturnType<typeof olderTasks>>[number]>;
