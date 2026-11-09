"use client";

import { History, Pencil } from "lucide-react";
import Link from "next/link";
import { useExtracted, useFormatter } from "next-intl";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { ActionTooltip } from "@/components/ui/tooltip";
import type { Recording } from "@/types/recording";
import type { MeetingDetail } from "./types";
import type { AgendaController } from "./use-agenda";

export function AgendaTaskSource({
    detail,
    recordings,
    canManage,
    busy,
    mutate,
}: {
    detail: MeetingDetail;
    recordings: Recording[];
    canManage: boolean;
    busy: boolean;
    mutate: AgendaController["mutate"];
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    const [editing, setEditing] = useState(false);
    const pencil = useRef<HTMLButtonElement>(null);
    const close = () => {
        setEditing(false);
        requestAnimationFrame(() => pencil.current?.focus());
    };
    return editing ? (
        <SearchCombobox
            aria-label={i18n("Task source")}
            open
            onOpenChange={(open) => {
                if (!open) close();
            }}
            value={
                detail.noTaskSource ? ":none" : (detail.taskSourceItemId ?? "")
            }
            placeholder={detail.taskSource?.title}
            disabled={busy}
            options={[
                { value: "", label: i18n("Automatic"), alwaysVisible: true },
                {
                    value: ":none",
                    label: i18n("No source"),
                    alwaysVisible: true,
                },
                ...recordings.map((recording) => ({
                    value: recording.id,
                    label: recording.filename,
                    description: format.dateTime(
                        new Date(recording.startTime),
                        { dateStyle: "medium", timeStyle: "short" },
                    ),
                })),
            ]}
            onValueChange={(sourceId) => {
                close();
                const noTaskSource = sourceId === ":none";
                const taskSourceItemId = noTaskSource ? null : sourceId || null;
                void mutate(
                    "",
                    "PATCH",
                    {
                        taskSourceItemId,
                        noTaskSource,
                        previous: {
                            noTaskSource: detail.noTaskSource,
                            taskSourceItemId: detail.taskSourceItemId,
                        },
                    },
                    (value) => ({
                        ...value,
                        taskSourceItemId,
                        noTaskSource,
                        taskSource: null,
                        snapshotSourceItemId: null,
                        tasks: value.tasks.filter(
                            (task) => task.agendaOrigin === "older",
                        ),
                    }),
                );
            }}
        />
    ) : (
        <span className="inline-flex items-center gap-1">
            <History className="size-3 shrink-0" aria-hidden="true" />
            <span>
                {detail.noTaskSource ? (
                    i18n("No tasks from other meetings")
                ) : detail.taskSource ? (
                    <>
                        {i18n("Tasks from the meeting")}{" "}
                        <Link
                            className="underline"
                            href={`/dashboard?recording=${encodeURIComponent(detail.taskSource.id)}`}
                        >
                            {detail.taskSource.title}
                        </Link>
                        {detail.taskSource.automatic && (
                            <> {i18n("(automatic)")}</>
                        )}
                    </>
                ) : (
                    i18n("No previous meeting with tasks")
                )}
            </span>
            {canManage && (
                <ActionTooltip label={i18n("Change task source")}>
                    <Button
                        ref={pencil}
                        size="icon-xs"
                        variant="ghost"
                        aria-label={i18n("Change task source")}
                        disabled={busy}
                        onClick={() => setEditing(true)}
                    >
                        <Pencil className="size-3" aria-hidden="true" />
                    </Button>
                </ActionTooltip>
            )}
        </span>
    );
}
