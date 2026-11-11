"use client";

import { CalendarClock, FolderInput } from "lucide-react";
import { useExtracted, useFormatter } from "next-intl";
import { useEffect, useState } from "react";
import { FolderRowLabels } from "@/components/dashboard/folder-row-labels";
import { cn } from "@/lib/utils";
import type { RecordingFolder } from "@/types/folder";
import { prewarmAgenda } from "./api";
import type { MeetingRowData } from "./types";

export function MeetingRow({
    meeting,
    selected,
    onSelect,
    registerRef,
    folders = [],
}: {
    meeting: MeetingRowData;
    selected: boolean;
    onSelect: (id: string) => void;
    registerRef?: (id: string, node: HTMLButtonElement | null) => void;
    folders?: RecordingFolder[];
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (meeting.recordingItemId || meeting.state !== "live") return;
        const timer = setInterval(() => setNow(Date.now()), 60000);
        return () => clearInterval(timer);
    }, [meeting.state, meeting.recordingItemId]);
    const liveMinutes = meeting.liveStartedAt
        ? Math.max(
              0,
              Math.floor((now - Date.parse(meeting.liveStartedAt)) / 60000),
          )
        : 0;
    return (
        <button
            type="button"
            ref={(node) => registerRef?.(meeting.id, node)}
            className={cn(
                "flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                selected && "bg-primary/5",
            )}
            onFocus={() => prewarmAgenda(meeting.id)}
            aria-pressed={selected}
            onClick={() => onSelect(meeting.id)}
            onMouseEnter={() => {
                prewarmAgenda(meeting.id);
            }}
        >
            <CalendarClock className="mt-1 size-4 shrink-0 text-meeting" />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                    {meeting.title}
                </span>
                {folders.length > 0 && (
                    <span className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                        <FolderRowLabels folders={folders} />
                    </span>
                )}
                <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>
                        {meeting.timeSet && meeting.start
                            ? format.dateTime(new Date(meeting.start), {
                                  dateStyle: "medium",
                                  timeStyle: "short",
                              })
                            : i18n("No scheduled time")}
                    </span>
                    {meeting.received && (
                        <FolderInput
                            className="size-3 text-person-share"
                            aria-label={i18n("Shared with you by {owner}", {
                                owner:
                                    meeting.author.name ?? i18n("a colleague"),
                            })}
                        />
                    )}
                    <span className="rounded-full bg-meeting/10 px-2 py-0.5 text-meeting">
                        {meeting.recorded || meeting.recordingItemId
                            ? i18n("Recorded")
                            : meeting.state === "live"
                              ? i18n("In progress")
                              : meeting.state === "held"
                                ? i18n("Agenda without recording")
                                : i18n("Preparing")}
                        {!meeting.recorded &&
                            !meeting.recordingItemId &&
                            meeting.state === "live" &&
                            meeting.liveStartedAt &&
                            ` · ${String(Math.floor(liveMinutes / 60)).padStart(2, "0")}:${String(liveMinutes % 60).padStart(2, "0")}`}
                    </span>
                </span>
            </span>
            <span className="mt-1 flex -space-x-1">
                {meeting.editors.slice(0, 3).map((editor) => (
                    <span
                        key={editor.id}
                        title={editor.name ?? undefined}
                        className="flex size-6 shrink-0 items-center justify-center rounded-full border border-background bg-muted text-[10px]"
                    >
                        {editor.name
                            ?.split(" ")
                            .map((word) => word[0])
                            .slice(0, 2)
                            .join("")}
                    </span>
                ))}
            </span>
        </button>
    );
}
