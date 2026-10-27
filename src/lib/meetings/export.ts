import { AppError, ErrorCode } from "@/lib/errors";
import {
    getCalendarEvent,
    writeCalendarAgenda,
} from "@/lib/integrations/google/calendar-events";
import { GOOGLE_CALENDAR_EVENTS_WRITE_SCOPE } from "@/lib/integrations/google/config";
import { getGoogleConnectionStatus } from "@/lib/integrations/google/connection";
import { requireMeetingAccess } from "@/lib/meetings/access";
import { getMeeting } from "@/lib/meetings/service";

type Detail = Exclude<
    Awaited<ReturnType<typeof getMeeting>>,
    { unchanged: true }
>;
const escapeMarkdown = (value: string) =>
    value.replace(/([\\`*_{}[\]<>#])/gu, "\\$1").replace(/[\r\n]/gu, " ");

/** Export only shared agenda content; assignee and live notes are deliberately omitted. */
export function meetingMarkdown(
    detail: Detail,
    includeTasks = true,
    locale: "en" | "cs-CZ" = "en",
): string {
    const cs = locale === "cs-CZ";
    const lines = [
        `# ${escapeMarkdown(detail.title)}`,
        "",
        [
            detail.timeSet ? detail.plannedStart?.toISOString() : null,
            detail.plannedEnd?.toISOString(),
            detail.invitees.length
                ? `${cs ? "Pozvaní" : "Invitees"}: ${detail.invitees.map((invitee) => escapeMarkdown(invitee.name)).join(", ")}`
                : null,
        ]
            .filter(Boolean)
            .join(" · "),
        "",
    ];
    if (includeTasks) {
        lines.push(`## 1. ${cs ? "Kontrola úkolů" : "Task review"}`, "");
        for (const group of detail.taskGroups) {
            if (!group.tasks.length) continue;
            lines.push(
                `### ${escapeMarkdown(group.name ?? (cs ? "Bez řešitele" : "No assignee"))}${group.name && !group.invited ? (cs ? " (není mezi pozvanými)" : " (not invited)") : ""}`,
            );
            for (const task of group.tasks)
                lines.push(
                    `- [${task.status === "done" ? "x" : " "}] ${escapeMarkdown(task.text)}${task.dueDate ? ` (${cs ? "termín" : "due"} ${task.dueDate})` : ""}${task.status === "dropped" ? (cs ? " (zrušeno)" : " (dropped)") : ""}`,
                );
            lines.push("");
        }
    }
    lines.push(
        `## ${includeTasks ? "2. " : ""}${cs ? "Body k projednání" : "Discussion points"}`,
        "",
    );
    function append(parentId: string | null, depth: number) {
        for (const point of detail.points
            .filter((entry) => entry.parentId === parentId)
            .sort(
                (a, b) => a.position - b.position || a.id.localeCompare(b.id),
            )) {
            lines.push(`${"  ".repeat(depth)}- ${escapeMarkdown(point.text)}`);
            if (depth < 2) append(point.id, depth + 1);
        }
    }
    append(null, 0);
    return `${lines.join("\n").trim()}\n`;
}

/** Markdown and a safe, readable download name, authorized through the meeting. */
export async function exportMeetingMarkdown(
    userId: string,
    id: string,
    locale: "en" | "cs-CZ" = "en",
) {
    const detail = await getMeeting(userId, id);
    if (detail.unchanged)
        throw new AppError(ErrorCode.NOT_FOUND, "Meeting not found", 404);
    const date = (detail.plannedStart ?? detail.createdAt)
        .toISOString()
        .slice(0, 10);
    return {
        markdown: meetingMarkdown(detail, true, locale),
        filename: `${date} ${detail.title.replace(/[\\/:*?"<>|\r\n]/gu, " ").slice(0, 150)} - agenda.md`,
    };
}

/** Explicit organizer-only export; obtaining write consent never performs the export itself. */
export async function exportMeetingCalendar(
    userId: string,
    id: string,
    includeTasks = false,
    locale: "en" | "cs-CZ" = "en",
) {
    const access = await requireMeetingAccess(userId, id);
    if (!access.agenda.calendarEventId)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Meeting has no Calendar event",
            400,
        );
    const event = await getCalendarEvent(userId, access.agenda.calendarEventId);
    if (!event.organizer?.self)
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only the event organizer may export the agenda",
            403,
        );
    const connection = await getGoogleConnectionStatus(userId);
    if (!connection?.scopes.includes(GOOGLE_CALENDAR_EVENTS_WRITE_SCOPE)) {
        const params = new URLSearchParams({
            purpose: "calendar-write",
            returnTo: `/dashboard?meeting=${encodeURIComponent(access.agenda.meetingItemId ?? id)}`,
        });
        return {
            needsConsent: true,
            connectUrl: `/api/integrations/google/connect?${params}`,
        };
    }
    const detail = await getMeeting(userId, id);
    if (detail.unchanged)
        throw new AppError(ErrorCode.NOT_FOUND, "Meeting not found", 404);
    return {
        needsConsent: false,
        ...(await writeCalendarAgenda(
            userId,
            event.id,
            meetingMarkdown(detail, includeTasks, locale),
            locale,
        )),
    };
}
