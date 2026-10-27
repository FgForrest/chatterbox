"use client";

import {
    CalendarClock,
    ChevronDown,
    Folder,
    Play,
    Square,
    Users,
    X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useExtracted, useFormatter } from "next-intl";
import { useEffect, useState } from "react";
import { announceTasksChanged } from "@/components/tasks/task-api";
import { TaskRow } from "@/components/tasks/task-row";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { groupAgendaTasks } from "@/lib/meetings/task-groups";
import type { TaskChange, TaskView } from "@/lib/tasks/tasks";
import { cn } from "@/lib/utils";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";
import { AgendaExport } from "./agenda-export";
import { meetingRequest, meetingUrl } from "./api";
import { AttachRecordingDialog } from "./attach-recording-dialog";
import { MeetingSettings } from "./meeting-settings";
import { OutlineEditor, type PointPatch } from "./outline-editor";
import type {
    MeetingDetail,
    MeetingPoint,
    MeetingTask,
    OlderTask,
} from "./types";
import { useAgenda } from "./use-agenda";

export type AgendaVariant = "meeting" | "live" | "recording";
function elapsed(start: string | null, now: number) {
    const seconds = start
        ? Math.max(0, Math.floor((now - Date.parse(start)) / 1000))
        : 0;
    return [
        Math.floor(seconds / 3600),
        Math.floor(seconds / 60) % 60,
        seconds % 60,
    ]
        .map((value) => String(value).padStart(2, "0"))
        .join(":");
}
export function AgendaBody({
    id,
    variant = "meeting",
    initial,
    userId,
    active = true,
    recordings = [],
    folders = [],
    onChanged,
    onDeleted,
    onRecording,
}: {
    id: string;
    variant?: AgendaVariant;
    initial?: MeetingDetail;
    userId?: string;
    active?: boolean;
    recordings?: Recording[];
    folders?: RecordingFolder[];
    onChanged?: () => void;
    onDeleted?: () => void;
    onRecording?: (id: string) => void;
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    const router = useRouter();
    const agenda = useAgenda(id, initial, active);
    const { detail, mutate } = agenda;
    const [collapsed, setCollapsed] = useState(variant === "recording");
    const [olderOpen, setOlderOpen] = useState(false);
    const [scope, setScope] = useState<"invited" | "all">("invited");
    const [older, setOlder] = useState<OlderTask[] | null>(null);
    const [olderError, setOlderError] = useState<string | null>(null);
    const [attachOpen, setAttachOpen] = useState(false);
    const [now, setNow] = useState(Date.now());
    const live = variant === "live" || detail?.state === "live";
    const readOnly =
        variant === "recording" || Boolean(detail?.recordingItemId);
    useEffect(() => {
        if (!live || !active) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [live, active]);
    useEffect(() => {
        if (variant !== "recording" && detail?.redirectTo)
            router.replace(detail.redirectTo);
    }, [detail?.redirectTo, router, variant]);
    useEffect(() => {
        if (!olderOpen) return;
        const controller = new AbortController();
        setOlder(null);
        setOlderError(null);
        void meetingRequest<{ tasks: OlderTask[] }>(
            meetingUrl(id, `/older-tasks?scope=${scope}`),
            "GET",
            undefined,
            controller.signal,
        )
            .then((result) => {
                if (!controller.signal.aborted) setOlder(result.tasks);
            })
            .catch((err: Error) => {
                if (!controller.signal.aborted) setOlderError(err.message);
            });
        return () => controller.abort();
    }, [id, olderOpen, scope]);
    if (!detail)
        return (
            <Card>
                <CardContent className="py-8">
                    <p role={agenda.error ? "alert" : "status"}>
                        {agenda.error ?? i18n("Loading agenda…")}
                    </p>
                    {agenda.error && (
                        <Button
                            variant="outline"
                            onClick={() => void agenda.reload().catch(() => {})}
                        >
                            {i18n("Try again")}
                        </Button>
                    )}
                </CardContent>
            </Card>
        );
    const canEdit = detail.permissions.edit && !readOnly;
    const groups = groupAgendaTasks(
        detail.tasks.filter((task) => !task.removedAt),
        detail.invitees,
    );
    const emptyInvitees = groups
        .filter((group) => group.invited && !group.tasks.length)
        .map((group) => group.name)
        .join(", ");
    const removed = detail.tasks.filter((task) => task.removedAt);
    const tasks = detail.tasks.filter((task) => !task.removedAt);
    const taskChanged = (task: MeetingTask) =>
        Boolean(
            detail.liveStartedAt &&
                task.statusChangedAt &&
                Date.parse(task.statusChangedAt) >=
                    Date.parse(detail.liveStartedAt) &&
                (!detail.liveEndedAt ||
                    Date.parse(task.statusChangedAt) <=
                        Date.parse(detail.liveEndedAt)),
        );
    const changedCount = tasks.filter(taskChanged).length;
    const discussed = detail.points.filter((point) => point.discussedAt).length;
    const busy = agenda.pending > 0;
    const patchPoint = (point: MeetingPoint, patch: PointPatch) => {
        void mutate(
            `/points/${encodeURIComponent(point.id)}`,
            "PATCH",
            (value: MeetingDetail) => ({
                ...patch,
                version:
                    value.points.find((entry) => entry.id === point.id)
                        ?.version ?? point.version,
            }),
            (value) => ({
                ...value,
                points: value.points.map((entry) =>
                    entry.id === point.id
                        ? {
                              ...entry,
                              ...patch,
                              ...(patch.discussed !== undefined
                                  ? {
                                        discussedAt: patch.discussed
                                            ? new Date().toISOString()
                                            : null,
                                    }
                                  : {}),
                              version: entry.version + 1,
                          }
                        : entry,
                ),
            }),
        );
    };
    const changeTask = (
        task: MeetingTask,
        change: Omit<TaskChange, "version">,
        optimistic: Partial<TaskView>,
    ) => {
        void mutate(
            `/api/tasks/${encodeURIComponent(task.id)}`,
            "PATCH",
            (value: MeetingDetail) => ({
                ...change,
                version:
                    value.tasks.find((entry) => entry.id === task.id)
                        ?.version ?? task.version,
            }),
            (value) => ({
                ...value,
                tasks: value.tasks.map((entry) =>
                    entry.id === task.id
                        ? {
                              ...entry,
                              ...optimistic,
                              ...(change.status
                                  ? {
                                        statusChangedAt:
                                            new Date().toISOString(),
                                    }
                                  : {}),
                          }
                        : entry,
                ),
            }),
        ).then(() => announceTasksChanged());
    };
    const removeTask = (task: MeetingTask, removed: boolean) =>
        void mutate(
            `/tasks/${encodeURIComponent(task.id)}`,
            "PATCH",
            { removed },
            (value) => ({
                ...value,
                tasks: value.tasks.map((entry) =>
                    entry.id === task.id
                        ? {
                              ...entry,
                              removedAt: removed
                                  ? new Date().toISOString()
                                  : null,
                          }
                        : entry,
                ),
            }),
        );
    const changeState = (state: "live" | "held") =>
        void mutate(
            "",
            "PATCH",
            (value: MeetingDetail) => ({ state, version: value.version }),
            (value) => ({
                ...value,
                state,
                ...(state === "live"
                    ? {
                          liveStartedAt:
                              value.liveStartedAt ?? new Date().toISOString(),
                          liveEndedAt: null,
                      }
                    : { liveEndedAt: new Date().toISOString() }),
            }),
        ).then(() => onChanged?.());
    const taskCard = (
        <Card className={cn(live && "order-2 sm:order-1")}>
            <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                    <CardTitle>{i18n("1 · Task review")}</CardTitle>
                    <span className="text-xs text-muted-foreground">
                        {i18n("{count, number} tasks · {done, number} done", {
                            count: tasks.length,
                            done: tasks.filter((task) => task.status === "done")
                                .length,
                        })}
                    </span>
                    {changedCount > 0 && (
                        <span className="text-xs text-muted-foreground">
                            {i18n(
                                "{count, number} changed during the meeting",
                                { count: changedCount },
                            )}
                        </span>
                    )}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {detail.taskSource ? (
                        <Link
                            className="underline"
                            href={`/dashboard?recording=${encodeURIComponent(detail.taskSource.id)}`}
                        >
                            {i18n("From the previous meeting: {title}", {
                                title: detail.taskSource.title,
                            })}
                        </Link>
                    ) : (
                        <span>{i18n("No previous meeting with tasks")}</span>
                    )}
                    {detail.permissions.manage && !readOnly && (
                        <label>
                            {i18n("Task source")}
                            <select
                                aria-label={i18n("Task source")}
                                className="ml-2 max-w-48 rounded border bg-background p-1"
                                value={detail.taskSourceItemId ?? ""}
                                disabled={busy}
                                onChange={(event) => {
                                    const taskSourceItemId =
                                        event.target.value || null;
                                    void mutate(
                                        "",
                                        "PATCH",
                                        (value: MeetingDetail) => ({
                                            taskSourceItemId,
                                            version: value.version,
                                        }),
                                        (value) => ({
                                            ...value,
                                            taskSourceItemId,
                                            tasks: [],
                                        }),
                                    );
                                }}
                            >
                                <option value="">{i18n("Automatic")}</option>
                                {recordings
                                    .filter(
                                        (recording) =>
                                            recording.kind !== "mail",
                                    )
                                    .map((recording) => (
                                        <option
                                            key={`${recording.id}:${recording.view}`}
                                            value={recording.id}
                                        >
                                            {recording.filename}
                                        </option>
                                    ))}
                            </select>
                        </label>
                    )}
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                {groups
                    .filter((group) => group.tasks.length)
                    .map((group) => (
                        <section
                            key={group.name ?? "unassigned"}
                            className="space-y-2"
                        >
                            <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
                                <span
                                    className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px]"
                                    aria-hidden="true"
                                >
                                    {group.name
                                        ?.split(" ")
                                        .map((word) => word[0])
                                        .slice(0, 2)
                                        .join("") ?? "?"}
                                </span>
                                {group.name ?? i18n("No assignee")}
                                {!group.invited && group.name && (
                                    <span className="rounded border px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                                        {i18n("Not invited")}
                                    </span>
                                )}
                            </h3>
                            <ul className="divide-y rounded-lg border">
                                {group.tasks.map((task) => (
                                    <TaskRow
                                        key={task.id}
                                        task={task}
                                        recording={task.recording}
                                        evidence={task.evidence}
                                        readOnly={readOnly || busy}
                                        notesReadOnly={live}
                                        actions={
                                            <>
                                                {task.agendaOrigin ===
                                                    "older" && (
                                                    <span>{i18n("Older")}</span>
                                                )}
                                                {taskChanged(task) && (
                                                    <span>
                                                        {i18n(
                                                            "Changed during the meeting",
                                                        )}
                                                    </span>
                                                )}
                                                {live &&
                                                    canEdit &&
                                                    task.status === "open" &&
                                                    task.canClose && (
                                                        <button
                                                            type="button"
                                                            disabled={busy}
                                                            onClick={() =>
                                                                changeTask(
                                                                    task,
                                                                    {
                                                                        status: "done",
                                                                    },
                                                                    {
                                                                        status: "done",
                                                                    },
                                                                )
                                                            }
                                                        >
                                                            {i18n("Done")}
                                                        </button>
                                                    )}
                                                {canEdit && (
                                                    <button
                                                        type="button"
                                                        disabled={busy}
                                                        aria-label={i18n(
                                                            "Remove {task} from agenda",
                                                            { task: task.text },
                                                        )}
                                                        onClick={() =>
                                                            removeTask(
                                                                task,
                                                                true,
                                                            )
                                                        }
                                                    >
                                                        {i18n(
                                                            "Remove from agenda",
                                                        )}
                                                    </button>
                                                )}
                                                {(live || task.agendaNote) && (
                                                    <AgendaTaskNote
                                                        task={task}
                                                        readOnly={!canEdit}
                                                        onSave={(note) => {
                                                            void mutate(
                                                                `/tasks/${encodeURIComponent(task.id)}`,
                                                                "PATCH",
                                                                { note },
                                                                (value) => ({
                                                                    ...value,
                                                                    tasks: value.tasks.map(
                                                                        (
                                                                            entry,
                                                                        ) =>
                                                                            entry.id ===
                                                                            task.id
                                                                                ? {
                                                                                      ...entry,
                                                                                      agendaNote:
                                                                                          note,
                                                                                  }
                                                                                : entry,
                                                                    ),
                                                                }),
                                                            );
                                                        }}
                                                    />
                                                )}
                                            </>
                                        }
                                        currentItemId={detail.taskSource?.id}
                                        organizationOnly={detail.folders.some(
                                            (folder) =>
                                                folders.find(
                                                    (entry) =>
                                                        entry.id === folder.id,
                                                )?.scope === "org",
                                        )}
                                        showAssignee={false}
                                        onChange={(change, optimistic) =>
                                            changeTask(task, change, optimistic)
                                        }
                                    />
                                ))}
                            </ul>
                        </section>
                    ))}
                {emptyInvitees && (
                    <p className="text-xs text-muted-foreground">
                        {i18n("Invitees without tasks: {names}", {
                            names: emptyInvitees,
                        })}
                    </p>
                )}
                {removed.length > 0 && canEdit && (
                    <div className="text-xs text-muted-foreground">
                        {i18n("{count, number} tasks removed from agenda", {
                            count: removed.length,
                        })}
                        {removed.map((task) => (
                            <Button
                                key={task.id}
                                variant="ghost"
                                size="sm"
                                disabled={busy}
                                title={task.text}
                                onClick={() => removeTask(task, false)}
                            >
                                {i18n("Restore")}
                            </Button>
                        ))}
                    </div>
                )}
                {!tasks.length && (
                    <p className="text-sm text-muted-foreground">
                        {i18n("No tasks in this agenda")}
                    </p>
                )}
                {canEdit && !live && (
                    <>
                        <Button
                            variant="ghost"
                            size="sm"
                            aria-expanded={olderOpen}
                            onClick={() => setOlderOpen((value) => !value)}
                        >
                            <ChevronDown className="size-4" />
                            {i18n("Older unfinished tasks in this folder")}
                        </Button>
                        {olderOpen && (
                            <section className="space-y-3 rounded-lg border p-3">
                                <div className="flex items-center justify-between gap-2">
                                    <h3 className="text-sm font-medium">
                                        {i18n("Older unfinished tasks")}
                                    </h3>
                                    <label className="text-xs">
                                        {i18n("Show")}
                                        <select
                                            className="ml-2 rounded border bg-background p-1"
                                            value={scope}
                                            onChange={(event) =>
                                                setScope(
                                                    event.target.value === "all"
                                                        ? "all"
                                                        : "invited",
                                                )
                                            }
                                        >
                                            <option value="invited">
                                                {i18n("Invitees only")}
                                            </option>
                                            <option value="all">
                                                {i18n("Everyone")}
                                            </option>
                                        </select>
                                    </label>
                                </div>
                                {olderError ? (
                                    <p role="alert">{olderError}</p>
                                ) : !older ? (
                                    <output>{i18n("Loading tasks…")}</output>
                                ) : (
                                    groupAgendaTasks(
                                        older.filter(
                                            (task) =>
                                                !detail.tasks.some(
                                                    (entry) =>
                                                        entry.id === task.id &&
                                                        !entry.removedAt,
                                                ),
                                        ),
                                        detail.invitees,
                                    )
                                        .filter((group) => group.tasks.length)
                                        .map((group) => (
                                            <section
                                                key={group.name ?? "unassigned"}
                                                className="space-y-2"
                                            >
                                                <h4 className="text-xs font-medium">
                                                    {group.name ??
                                                        i18n("No assignee")}
                                                    {!group.invited &&
                                                        group.name && (
                                                            <span className="ml-2 text-muted-foreground">
                                                                {i18n(
                                                                    "Not invited",
                                                                )}
                                                            </span>
                                                        )}
                                                </h4>
                                                <ul className="divide-y rounded-lg border">
                                                    {group.tasks.map((task) => (
                                                        <TaskRow
                                                            key={task.id}
                                                            task={task}
                                                            recording={
                                                                task.recording
                                                            }
                                                            evidence={
                                                                task.evidence
                                                            }
                                                            readOnly
                                                            showAssignee={false}
                                                            organizationOnly={
                                                                false
                                                            }
                                                            onChange={() => {}}
                                                            actions={
                                                                <Button
                                                                    size="sm"
                                                                    variant="ghost"
                                                                    disabled={
                                                                        busy
                                                                    }
                                                                    onClick={() =>
                                                                        void mutate(
                                                                            "/tasks",
                                                                            "POST",
                                                                            {
                                                                                taskId: task.id,
                                                                            },
                                                                            (
                                                                                value,
                                                                            ) => ({
                                                                                ...value,
                                                                                tasks: [
                                                                                    ...value.tasks.filter(
                                                                                        (
                                                                                            entry,
                                                                                        ) =>
                                                                                            entry.id !==
                                                                                            task.id,
                                                                                    ),
                                                                                    {
                                                                                        ...task,
                                                                                        removedAt:
                                                                                            null,
                                                                                        agendaNote:
                                                                                            null,
                                                                                        agendaOrigin:
                                                                                            "older",
                                                                                        position: 100000,
                                                                                    },
                                                                                ],
                                                                            }),
                                                                        )
                                                                    }
                                                                >
                                                                    {i18n(
                                                                        "Add to agenda",
                                                                    )}
                                                                </Button>
                                                            }
                                                        />
                                                    ))}
                                                </ul>
                                            </section>
                                        ))
                                )}
                                {older?.length === 0 && (
                                    <p className="text-xs text-muted-foreground">
                                        {i18n("No older unfinished tasks")}
                                    </p>
                                )}
                            </section>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
    const pointsCard = (
        <Card className={cn(live && "order-1 sm:order-2")}>
            <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle>{i18n("2 · Discussion points")}</CardTitle>
                    <span className="text-xs text-muted-foreground">
                        {live || readOnly
                            ? i18n(
                                  "{discussed, number} of {total, number} discussed",
                                  { discussed, total: detail.points.length },
                              )
                            : i18n(
                                  "{count, plural, one {# point} other {# points}}",
                                  { count: detail.points.length },
                              )}
                    </span>
                    {canEdit && !live && (
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                                void mutate(
                                    "/suggestions",
                                    "POST",
                                    {},
                                    (value) => value,
                                )
                            }
                        >
                            {i18n("Suggest points")}
                        </Button>
                    )}
                </div>
            </CardHeader>
            <CardContent>
                <OutlineEditor
                    detail={detail}
                    userId={userId}
                    readOnly={readOnly}
                    live={live}
                    pending={busy}
                    onPatch={patchPoint}
                    onRemove={(point, mergeUp = false) => {
                        const descendants = new Set([point.id]);
                        if (!mergeUp)
                            for (let depth = 0; depth < 3; depth++)
                                for (const entry of detail.points)
                                    if (
                                        entry.parentId &&
                                        descendants.has(entry.parentId)
                                    )
                                        descendants.add(entry.id);
                        void mutate(
                            `/points/${encodeURIComponent(point.id)}?version=${point.version}&mergeUp=${mergeUp}`,
                            "DELETE",
                            undefined,
                            (value) => ({
                                ...value,
                                points: value.points
                                    .filter(
                                        (entry) => !descendants.has(entry.id),
                                    )
                                    .map((entry) =>
                                        mergeUp && entry.parentId === point.id
                                            ? {
                                                  ...entry,
                                                  parentId: point.parentId,
                                              }
                                            : entry,
                                    ),
                            }),
                        );
                    }}
                    onAdd={(text, parentId, position) => {
                        const at = new Date().toISOString();
                        const point: MeetingPoint = {
                            id: `pending-${crypto.randomUUID()}`,
                            agendaId: detail.id,
                            userId: detail.userId,
                            authorUserId: userId ?? null,
                            text,
                            parentId,
                            position,
                            origin: live ? "live" : "manual",
                            originPointId: null,
                            discussedAt: null,
                            discussedByUserId: null,
                            note: null,
                            noteAt: null,
                            summaryOutcome: null,
                            version: 0,
                            createdAt: at,
                            updatedAt: at,
                        };
                        return mutate(
                            "/points",
                            "POST",
                            { text, parentId, position, origin: point.origin },
                            (value) => ({
                                ...value,
                                points: [
                                    ...value.points.map((entry) =>
                                        entry.position >= position
                                            ? {
                                                  ...entry,
                                                  position: entry.position + 1,
                                              }
                                            : entry,
                                    ),
                                    point,
                                ],
                            }),
                        );
                    }}
                />
                {!readOnly && (
                    <output className="mt-3 block text-xs text-muted-foreground">
                        {busy
                            ? i18n("Saving…")
                            : i18n(
                                  "Saved · Colleagues’ changes load automatically",
                              )}
                    </output>
                )}
            </CardContent>
        </Card>
    );
    const suggestions = detail.suggestions.filter(
        (suggestion) => suggestion.state === "open",
    );
    return (
        <div className="space-y-4" data-agenda-variant={variant}>
            {variant !== "recording" ? (
                <header className="space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                            <h1 className="flex items-center gap-2 text-xl font-semibold">
                                <CalendarClock className="size-5 shrink-0 text-meeting" />
                                {detail.title}
                            </h1>
                            <p className="mt-1 text-sm text-muted-foreground">
                                {detail.timeSet && detail.plannedStart
                                    ? format.dateTime(
                                          new Date(detail.plannedStart),
                                          {
                                              dateStyle: "medium",
                                              timeStyle: "short",
                                          },
                                      )
                                    : i18n("No scheduled time")}
                                {detail.plannedEnd && (
                                    <>
                                        –
                                        {format.dateTime(
                                            new Date(detail.plannedEnd),
                                            { timeStyle: "short" },
                                        )}
                                    </>
                                )}
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <AgendaExport detail={detail} disabled={busy} />
                            {detail.permissions.manage && !readOnly && (
                                <MeetingSettings
                                    detail={detail}
                                    recordings={recordings}
                                    onSave={(change, optimistic) =>
                                        mutate(
                                            "",
                                            "PATCH",
                                            (value: MeetingDetail) => ({
                                                ...change,
                                                version: value.version,
                                            }),
                                            (value) => ({
                                                ...value,
                                                ...optimistic,
                                            }),
                                        ).then(() => onChanged?.())
                                    }
                                    onDelete={() =>
                                        mutate(
                                            "",
                                            "DELETE",
                                            undefined,
                                            (value) => value,
                                        ).then((saved) => {
                                            if (saved) {
                                                onDeleted?.();
                                                onChanged?.();
                                            }
                                        })
                                    }
                                />
                            )}
                            {detail.permissions.manage && !readOnly && (
                                <Button
                                    size="sm"
                                    disabled={busy}
                                    onClick={() =>
                                        changeState(live ? "held" : "live")
                                    }
                                >
                                    {live ? (
                                        <Square className="size-3" />
                                    ) : (
                                        <Play className="size-3" />
                                    )}
                                    {live
                                        ? i18n("End meeting")
                                        : i18n("Start meeting")}
                                </Button>
                            )}
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {detail.folders.map((folder) => {
                            const organization =
                                folders.find((entry) => entry.id === folder.id)
                                    ?.scope === "org";
                            return (
                                <Link
                                    key={folder.id}
                                    href={`/dashboard?folder=${encodeURIComponent(folder.id)}`}
                                    className={cn(
                                        "inline-flex items-center gap-1 rounded-full border px-2 py-1",
                                        organization &&
                                            "border-organization/30 text-organization",
                                    )}
                                >
                                    {organization ? (
                                        <Users className="size-3" />
                                    ) : (
                                        <Folder className="size-3" />
                                    )}
                                    {folder.name}
                                </Link>
                            );
                        })}
                        {detail.calendarEventId &&
                            (detail.calendar?.htmlLink ? (
                                <a
                                    className="rounded-full border px-2 py-1"
                                    href={detail.calendar.htmlLink}
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    {i18n("Calendar event")}
                                </a>
                            ) : (
                                <span className="rounded-full border px-2 py-1">
                                    {i18n("Calendar event")}
                                </span>
                            ))}
                        {detail.invitees.length > 0 && (
                            <span
                                className="rounded-full border px-2 py-1"
                                title={detail.invitees
                                    .map((invitee) => invitee.name)
                                    .join(", ")}
                            >
                                {i18n("Invitees")}:{" "}
                                {detail.invitees
                                    .map((invitee) => invitee.name)
                                    .join(", ")}
                            </span>
                        )}
                        <span className="rounded-full border px-2 py-1">
                            {i18n("Editors")}:{" "}
                            {detail.authors
                                .map(
                                    (author) =>
                                        author.name ?? i18n("Unknown author"),
                                )
                                .join(", ")}
                        </span>
                        <span className="rounded-full bg-meeting/10 px-2 py-1 text-meeting">
                            {live
                                ? i18n("In progress")
                                : detail.state === "held"
                                  ? i18n("Without recording")
                                  : i18n("Preparing")}
                        </span>
                    </div>
                    {live && (
                        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-meeting/30 bg-meeting/5 p-3 text-sm">
                            <time className="font-mono tabular-nums">
                                {elapsed(detail.liveStartedAt, now)}
                            </time>
                            <span>
                                {i18n(
                                    "{discussed, number} of {total, number} points discussed · {tasks, number} tasks changed",
                                    {
                                        discussed,
                                        total: detail.points.length,
                                        tasks: changedCount,
                                    },
                                )}
                            </span>
                        </div>
                    )}
                    {detail.state === "held" && (
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                            <p className="max-w-xl text-muted-foreground">
                                {i18n(
                                    "The meeting ended without a recording. Discussed points and notes remain, and task changes already apply. You can attach a recording later.",
                                )}
                            </p>
                            {canEdit && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setAttachOpen(true)}
                                >
                                    {i18n("Attach recording…")}
                                </Button>
                            )}
                        </div>
                    )}
                </header>
            ) : (
                <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 text-left"
                    aria-expanded={!collapsed}
                    onClick={() => setCollapsed((value) => !value)}
                >
                    <span>
                        <span className="font-medium">{i18n("Agenda")}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                            {i18n(
                                "{discussed, number} of {total, number} points discussed · {tasks, number} tasks",
                                {
                                    discussed,
                                    total: detail.points.length,
                                    tasks: tasks.length,
                                },
                            )}
                        </span>
                    </span>
                    <ChevronDown
                        className={cn("size-4", !collapsed && "rotate-180")}
                    />
                </button>
            )}
            {agenda.colleagueChange && (
                <output className="flex items-center justify-between rounded-lg border bg-muted/30 p-3 text-sm">
                    {i18n(
                        "A colleague changed the agenda. Their changes are shown below.",
                    )}
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={i18n("Dismiss change notice")}
                        onClick={agenda.dismissChange}
                    >
                        <X className="size-3" />
                    </Button>
                </output>
            )}
            {agenda.error && (
                <p role="alert" className="text-sm">
                    {agenda.error}
                </p>
            )}
            {!collapsed && (
                <>
                    <div className="flex flex-col gap-4">
                        {taskCard}
                        {pointsCard}
                    </div>
                    {canEdit &&
                        !live &&
                        (["carry_over", "ai"] as const).map((kind) => {
                            const offered = suggestions.filter(
                                (suggestion) => suggestion.kind === kind,
                            );
                            return (
                                offered.length > 0 && (
                                    <section
                                        key={kind}
                                        className="space-y-3 rounded-lg border bg-muted/20 p-4"
                                    >
                                        <h3 className="text-sm font-medium">
                                            {kind === "carry_over"
                                                ? i18n("Not covered last time")
                                                : i18n(
                                                      "Suggestions from activity since the last meeting",
                                                  )}
                                        </h3>
                                        {kind === "ai" && (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                disabled={busy}
                                                onClick={() => {
                                                    void Promise.all(
                                                        offered.map(
                                                            (suggestion) =>
                                                                mutate(
                                                                    `/suggestions/${encodeURIComponent(suggestion.id)}`,
                                                                    "PATCH",
                                                                    {
                                                                        state: "dismissed",
                                                                    },
                                                                    (
                                                                        value,
                                                                    ) => ({
                                                                        ...value,
                                                                        suggestions:
                                                                            value.suggestions.map(
                                                                                (
                                                                                    entry,
                                                                                ) =>
                                                                                    entry.id ===
                                                                                    suggestion.id
                                                                                        ? {
                                                                                              ...entry,
                                                                                              state: "dismissed",
                                                                                          }
                                                                                        : entry,
                                                                            ),
                                                                    }),
                                                                ),
                                                        ),
                                                    );
                                                }}
                                            >
                                                {i18n("Dismiss all")}
                                            </Button>
                                        )}
                                        {offered.map((suggestion) => (
                                            <div
                                                key={suggestion.id}
                                                className="flex flex-wrap items-start gap-2 rounded-md border bg-card p-3 text-sm"
                                            >
                                                <div className="min-w-0 flex-1">
                                                    <p>{suggestion.text}</p>
                                                    {suggestion.parentPointId && (
                                                        <p className="text-xs text-muted-foreground">
                                                            {i18n(
                                                                "Under: {point}",
                                                                {
                                                                    point:
                                                                        detail.points.find(
                                                                            (
                                                                                point,
                                                                            ) =>
                                                                                point.id ===
                                                                                suggestion.parentPointId,
                                                                        )
                                                                            ?.text ??
                                                                        "",
                                                                },
                                                            )}
                                                        </p>
                                                    )}
                                                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                                                        {suggestion.sources?.itemIds?.map(
                                                            (itemId) => (
                                                                <Link
                                                                    className="underline"
                                                                    key={itemId}
                                                                    href={`/dashboard?recording=${encodeURIComponent(itemId)}`}
                                                                >
                                                                    {recordings.find(
                                                                        (
                                                                            recording,
                                                                        ) =>
                                                                            recording.id ===
                                                                            itemId,
                                                                    )
                                                                        ?.filename ??
                                                                        i18n(
                                                                            "Source item",
                                                                        )}
                                                                </Link>
                                                            ),
                                                        )}
                                                        {suggestion.sources?.taskIds?.map(
                                                            (taskId) => (
                                                                <Link
                                                                    className="underline"
                                                                    key={taskId}
                                                                    href="/tasks"
                                                                >
                                                                    {detail.tasks.find(
                                                                        (
                                                                            task,
                                                                        ) =>
                                                                            task.id ===
                                                                            taskId,
                                                                    )?.text ??
                                                                        i18n(
                                                                            "Source task",
                                                                        )}
                                                                </Link>
                                                            ),
                                                        )}
                                                    </div>
                                                </div>
                                                {(
                                                    [
                                                        "added",
                                                        "dismissed",
                                                    ] as const
                                                ).map((state) => (
                                                    <Button
                                                        key={state}
                                                        size="sm"
                                                        variant="ghost"
                                                        disabled={busy}
                                                        onClick={() =>
                                                            void mutate(
                                                                `/suggestions/${encodeURIComponent(suggestion.id)}`,
                                                                "PATCH",
                                                                { state },
                                                                (value) => ({
                                                                    ...value,
                                                                    suggestions:
                                                                        value.suggestions.map(
                                                                            (
                                                                                entry,
                                                                            ) =>
                                                                                entry.id ===
                                                                                suggestion.id
                                                                                    ? {
                                                                                          ...entry,
                                                                                          state,
                                                                                      }
                                                                                    : entry,
                                                                        ),
                                                                }),
                                                            )
                                                        }
                                                    >
                                                        {state === "added"
                                                            ? i18n("Add")
                                                            : i18n("Dismiss")}
                                                    </Button>
                                                ))}
                                            </div>
                                        ))}
                                    </section>
                                )
                            );
                        })}
                </>
            )}
            {attachOpen && (
                <AttachRecordingDialog
                    detail={detail}
                    recordings={recordings.filter(
                        (recording) =>
                            recording.kind !== "mail" &&
                            recording.isOwn !== false &&
                            recording.view !== "org" &&
                            recording.view !== "received",
                    )}
                    folders={folders}
                    open
                    onOpenChange={setAttachOpen}
                    onAttached={(recordingId) => {
                        onChanged?.();
                        onRecording?.(recordingId);
                    }}
                />
            )}
        </div>
    );
}

function AgendaTaskNote({
    task,
    readOnly,
    onSave,
}: {
    task: MeetingTask;
    readOnly: boolean;
    onSave: (note: string | null) => void;
}) {
    const i18n = useExtracted();
    const [draft, setDraft] = useState(task.agendaNote ?? "");
    useEffect(() => setDraft(task.agendaNote ?? ""), [task.agendaNote]);
    return readOnly ? (
        <span>{task.agendaNote}</span>
    ) : (
        <input
            aria-label={i18n("Meeting note for {task}", { task: task.text })}
            placeholder={i18n("Meeting note")}
            className="w-full rounded border bg-background px-2 py-1 text-xs"
            value={draft}
            maxLength={2000}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
                if ((draft.trim() || null) !== task.agendaNote)
                    onSave(draft.trim() || null);
            }}
            onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
            }}
        />
    );
}
