"use client";

import {
    History,
    ListX,
    MessageSquareText,
    PencilLine,
    Play,
    Square,
    WandSparkles,
    X,
} from "lucide-react";
import { nanoid } from "nanoid";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useExtracted, useFormatter } from "next-intl";
import {
    type ComponentProps,
    type ReactNode,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
} from "react";
import { ItemHeader } from "@/components/items/item-header";
import { ProvenanceLine } from "@/components/pipeline/provenance-line";
import {
    WorkflowWidget,
    WorkflowWidgetLine,
    type WorkflowWidgetProps,
} from "@/components/pipeline/workflow-widget";
import { ReceivedItemBanner } from "@/components/sharing/person-sharing";
import { announceTasksChanged } from "@/components/tasks/task-api";
import { TaskRow } from "@/components/tasks/task-row";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EditorActions } from "@/components/ui/editor-actions";
import { InlineEditorTrigger } from "@/components/ui/inline-editor-trigger";
import { Textarea } from "@/components/ui/textarea";
import { ActionTooltip } from "@/components/ui/tooltip";
import { hasAgendaContributors } from "@/lib/meetings/attribution";
import { inviteeNames } from "@/lib/meetings/invitee-names";
import { moveAgendaPoint } from "@/lib/meetings/point-order";
import { groupAgendaTasks } from "@/lib/meetings/task-groups";
import type { TaskChange, TaskView } from "@/lib/tasks/tasks";
import { cn } from "@/lib/utils";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";
import { AgendaAttribution } from "./agenda-attribution";
import { AgendaCalendarExport, AgendaExport } from "./agenda-export";
import { AgendaFolderTags } from "./agenda-folder-tags";
import { AgendaShortcuts } from "./agenda-shortcuts";
import { AgendaTaskGroups } from "./agenda-task-groups";
import { AgendaTaskSource } from "./agenda-task-source";
import { AttachRecordingDialog } from "./attach-recording-dialog";
import { MeetingSettings } from "./meeting-settings";
import { OlderTasksDialog } from "./older-tasks-dialog";
import { OutlineEditor, type PointPatch } from "./outline-editor";
import type { MeetingDetail, MeetingPoint, MeetingTask } from "./types";
import { useAgenda } from "./use-agenda";
import { useAgendaCollapse } from "./use-agenda-collapse";
import { useAgendaText } from "./use-agenda-text";

export type AgendaVariant = "meeting" | "live" | "recording";
function taskAttribution(task: MeetingTask) {
    return task.statusChangedAt &&
        (!task.agendaUpdatedAt || task.statusChangedAt > task.agendaUpdatedAt)
        ? { at: task.statusChangedAt, userId: task.statusChangedByUserId }
        : { at: task.agendaUpdatedAt, userId: task.agendaUpdatedByUserId };
}
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
    const agenda = useAgenda(id, initial, {
        active,
        pollEnabled: variant !== "recording",
        userId,
    });
    const { detail, mutate } = agenda;
    const [tasksCollapsed, toggleTasks] = useAgendaCollapse(id, "tasks");
    const [pointsCollapsed, togglePoints] = useAgendaCollapse(id, "points");
    const [olderOpen, setOlderOpen] = useState(false);
    const [attachOpen, setAttachOpen] = useState(false);
    const [now, setNow] = useState(Date.now());
    const suggestionsReasonId = useId();
    const sourceRecordings = useMemo(() => {
        const folderIds = new Set(detail?.folderRecordingIds ?? []);
        return [
            ...new Map(
                recordings
                    .filter((recording) => recording.kind !== "mail")
                    .map((recording) => [recording.id, recording]),
            ).values(),
        ].sort(
            (a, b) =>
                Number(folderIds.has(b.id)) - Number(folderIds.has(a.id)) ||
                Date.parse(b.startTime) - Date.parse(a.startTime) ||
                a.id.localeCompare(b.id),
        );
    }, [recordings, detail?.folderRecordingIds]);
    const readOnly =
        variant === "recording" ||
        Boolean(detail?.attachedRecording) ||
        Boolean(detail?.recordingItemId);
    const live = !readOnly && (variant === "live" || detail?.state === "live");
    useEffect(() => {
        if (!live || !active) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [live, active]);
    useEffect(() => {
        if (variant !== "recording" && detail?.redirectTo)
            router.replace(detail.redirectTo);
    }, [detail?.redirectTo, router, variant]);
    if (!detail)
        return (
            <Card>
                <CardContent className="py-8">
                    <p role={agenda.error ? "alert" : "status"}>
                        {agenda.error ?? i18n("Loading agenda…")}
                    </p>
                    {agenda.conflict && (
                        <p role="alert" className="text-sm">
                            {i18n(
                                "Someone else changed this agenda. Your input is kept. Review their changes and try again.",
                            )}
                        </p>
                    )}
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
    const showAttribution = hasAgendaContributors(detail);
    const suggestionsErrorCode =
        "errorCode" in detail.aiSuggestions
            ? detail.aiSuggestions.errorCode
            : undefined;
    const suggestionsReason = detail.aiSuggestions.available
        ? null
        : detail.aiSuggestions.reason ===
            "Choose a default processing profile before running this step"
          ? i18n("Choose a default processing profile to suggest points.")
          : suggestionsErrorCode === "CONFLICT"
            ? i18n(
                  "The selected summary provider is disabled. Enable it or update the processing profile.",
              )
            : suggestionsErrorCode === "FORBIDDEN"
              ? i18n(
                    "Your Organization access does not permit using the selected summary provider.",
                )
              : suggestionsErrorCode === "NOT_FOUND"
                ? i18n(
                      "The agenda folder or selected summary provider is unavailable. Check the folder and processing profile.",
                  )
                : suggestionsErrorCode === "INVALID_INPUT"
                  ? i18n(
                        "Choose a chat provider for summaries in the processing profile to suggest points.",
                    )
                  : i18n(
                        "Configure the processing profile’s summary provider and its default model to suggest points.",
                    );
    const groups = groupAgendaTasks(
        detail.tasks.filter((task) => !task.removedAt),
        detail.invitees,
        detail.taskGroupOrder,
    );
    const emptyInvitees = inviteeNames([
        ...groups
            .filter((group) => group.invited && !group.tasks.length)
            .map((group) => ({ name: group.name ?? "" })),
        ...detail.invitees.filter((invitee) => !invitee.name.trim()),
    ]);
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
    const topLevelPoints = detail.points.filter((point) => !point.parentId);
    const discussed = topLevelPoints.filter(
        (point) => point.discussedAt,
    ).length;
    const busy = agenda.pending > 0;
    const taskPending = (taskId: string) =>
        agenda.pendingPaths.some(
            (path) =>
                path === `/tasks/${encodeURIComponent(taskId)}` ||
                path === `/api/tasks/${encodeURIComponent(taskId)}`,
        );
    const job = detail.aiSuggestions.job;
    const suggesting = job?.state === "queued" || job?.state === "running";
    const suggest = () =>
        void mutate("/suggestions", "POST", {}, (value) => ({
            ...value,
            aiSuggestions: { ...value.aiSuggestions, job: { state: "queued" } },
        }));
    const patchPoint = (point: MeetingPoint, patch: PointPatch) => {
        return mutate(
            `/points/${encodeURIComponent(point.id)}`,
            "PATCH",
            { ...patch, version: point.version },
            (value) => ({
                ...value,
                points: (patch.siblingIndex !== undefined
                    ? (moveAgendaPoint(
                          value.points,
                          point.id,
                          patch.parentId !== undefined
                              ? patch.parentId
                              : point.parentId,
                          patch.siblingIndex,
                      ) ?? value.points)
                    : value.points
                ).map((entry) =>
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
                        : patch.siblingIndex !== undefined &&
                            entry.position !==
                                value.points.find(
                                    (shown) => shown.id === entry.id,
                                )?.position
                          ? { ...entry, version: entry.version + 1 }
                          : patch.position !== undefined &&
                              entry.position >= patch.position
                            ? { ...entry, position: entry.position + 1 }
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
        void mutate("", "PATCH", { state }, (value) => ({
            ...value,
            state,
            ...(state === "live"
                ? {
                      liveStartedAt:
                          value.liveStartedAt ?? new Date().toISOString(),
                      liveEndedAt: null,
                  }
                : { liveEndedAt: new Date().toISOString() }),
        })).then(() => onChanged?.());
    const taskCount = i18n("{count, plural, one {# task} other {# tasks}}", {
        count: tasks.length,
    });
    const doneCount = i18n("{count, number} done", {
        count: tasks.filter((task) => task.status === "done").length,
    });
    const pointCount =
        live || readOnly
            ? i18n("{discussed, number} of {total, number} discussed", {
                  discussed,
                  total: topLevelPoints.length,
              })
            : i18n("{count, plural, one {# point} other {# points}}", {
                  count: topLevelPoints.length,
              });
    const taskCard = (
        <div className={cn(live && "order-2 sm:order-1")}>
            <AgendaSection
                recording={variant === "recording"}
                id={`agenda-${id}-tasks`}
                frame="inline"
                tone="quiet"
                title={i18n("1 · Task review")}
                collapsed={tasksCollapsed}
                onCollapse={toggleTasks}
                collapseLabel={i18n("Collapse task review")}
                expandLabel={i18n("Expand task review")}
                inlineLine={
                    tasksCollapsed ? (
                        <WorkflowWidgetLine
                            title={i18n("1 · Task review")}
                            facts={`${taskCount} · ${doneCount} · ${detail.noTaskSource ? i18n("No tasks from other meetings") : detail.taskSource ? i18n("from {meeting}", { meeting: detail.taskSource.title }) : i18n("No previous meeting with tasks")}`}
                            onExpand={toggleTasks}
                            expandLabel={i18n("Expand task review")}
                        />
                    ) : undefined
                }
                headerAction={
                    canEdit &&
                    !live && (
                        <OlderTasksDialog
                            detail={detail}
                            open={olderOpen}
                            onOpenChange={setOlderOpen}
                            mutate={mutate}
                        />
                    )
                }
                footer={{
                    actions: null,
                    status: (
                        <ProvenanceLine
                            items={[
                                {
                                    key: "source",
                                    content: (
                                        <AgendaTaskSource
                                            detail={detail}
                                            recordings={sourceRecordings}
                                            canManage={
                                                detail.permissions.manage &&
                                                !readOnly
                                            }
                                            busy={busy}
                                            mutate={mutate}
                                        />
                                    ),
                                },
                                { key: "count", content: taskCount },
                                { key: "done", content: doneCount },
                                {
                                    key: "changed",
                                    content:
                                        (live || changedCount > 0) &&
                                        i18n(
                                            "{count, number} changed during the meeting",
                                            { count: changedCount },
                                        ),
                                },
                            ]}
                        />
                    ),
                }}
                bodyClassName="space-y-4"
            >
                <AgendaTaskGroups
                    detail={detail}
                    canEdit={canEdit}
                    mutate={mutate}
                    renderTask={(task, controls) => (
                        <AgendaTaskRow
                            key={task.id}
                            rowProps={controls.rowProps}
                            leading={controls.leading}
                            orderActions={controls.actions}
                            showAttribution={showAttribution}
                            task={task}
                            agendaId={detail.id}
                            collaborative={detail.textProtocol === 1}
                            attribution={
                                detail.authors.find(
                                    (author) =>
                                        author.id ===
                                        taskAttribution(task).userId,
                                )?.name
                            }
                            recording={task.recording}
                            evidence={task.evidence}
                            readOnly={readOnly || (live && !canEdit)}
                            pending={taskPending(task.id)}
                            canEdit={canEdit}
                            live={live}
                            changed={taskChanged(task)}
                            onRemove={() => removeTask(task, true)}
                            onNote={(note) =>
                                mutate(
                                    `/tasks/${encodeURIComponent(task.id)}`,
                                    "PATCH",
                                    { note },
                                    (value) => ({
                                        ...value,
                                        tasks: value.tasks.map((entry) =>
                                            entry.id === task.id
                                                ? {
                                                      ...entry,
                                                      agendaNote: note,
                                                  }
                                                : entry,
                                        ),
                                    }),
                                )
                            }
                            currentItemId={detail.taskSource?.id}
                            organizationOnly={detail.folders.some(
                                (folder) =>
                                    folders.find(
                                        (entry) => entry.id === folder.id,
                                    )?.scope === "org",
                            )}
                            showAssignee={false}
                            onChange={(change, optimistic) =>
                                changeTask(task, change, optimistic)
                            }
                        />
                    )}
                />
                {emptyInvitees && (
                    <p className="text-xs text-muted-foreground">
                        {i18n("Invitees without tasks: {names}", {
                            names: emptyInvitees,
                        })}
                    </p>
                )}
                {removed.length > 0 && canEdit && (
                    <div className="text-xs text-muted-foreground">
                        {i18n(
                            "{count, plural, one {# task removed from agenda} other {# tasks removed from agenda}}",
                            {
                                count: removed.length,
                            },
                        )}
                        {removed.map((task) => (
                            <Button
                                key={task.id}
                                variant="ghost"
                                size="sm"
                                disabled={taskPending(task.id)}
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
                        {canEdit && !live
                            ? i18n(
                                  "No tasks. Add older tasks with the icon in the header.",
                              )
                            : i18n("No tasks in this agenda")}
                    </p>
                )}
            </AgendaSection>
        </div>
    );
    const pointsCard = (
        <div className={cn(live && "order-1 sm:order-2")}>
            <AgendaSection
                recording={variant === "recording"}
                divider
                id={`agenda-${id}-points`}
                frame="inline"
                tone="quiet"
                title={i18n("2 · Discussion points")}
                collapsed={pointsCollapsed}
                onCollapse={togglePoints}
                collapseLabel={i18n("Collapse discussion points")}
                expandLabel={i18n("Expand discussion points")}
                inlineLine={
                    pointsCollapsed ? (
                        <WorkflowWidgetLine
                            title={i18n("2 · Discussion points")}
                            facts={pointCount}
                            onExpand={togglePoints}
                            expandLabel={i18n("Expand discussion points")}
                        />
                    ) : undefined
                }
                headerAction={
                    <div className="flex items-center gap-1">
                        {canEdit && !live && (
                            <ActionTooltip label={i18n("Suggest points")}>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={i18n("Suggest points")}
                                    disabled={
                                        busy ||
                                        suggesting ||
                                        !detail.aiSuggestions.available
                                    }
                                    aria-describedby={
                                        suggestionsReason
                                            ? suggestionsReasonId
                                            : undefined
                                    }
                                    onClick={suggest}
                                >
                                    <WandSparkles
                                        className="size-4"
                                        aria-hidden="true"
                                    />
                                </Button>
                            </ActionTooltip>
                        )}
                        {canEdit && <AgendaShortcuts />}
                    </div>
                }
                footer={{
                    actions: null,
                    status: (
                        <ProvenanceLine
                            items={[
                                { key: "count", content: pointCount },
                                {
                                    key: "save",
                                    content: !readOnly && (
                                        <output>
                                            {busy
                                                ? i18n("Saving…")
                                                : i18n("Saved")}
                                        </output>
                                    ),
                                },
                                {
                                    key: "job",
                                    content: canEdit && suggesting && (
                                        <output>
                                            {job.state === "queued"
                                                ? i18n("Suggestions queued…")
                                                : i18n("Suggesting points…")}
                                        </output>
                                    ),
                                },
                            ]}
                        />
                    ),
                }}
                bodyClassName="space-y-3"
            >
                {canEdit && job?.state === "failed" && (
                    <div
                        role="alert"
                        className="flex items-center gap-2 text-sm"
                    >
                        <span>
                            {job.errorCode === "INVALID_INPUT"
                                ? i18n(
                                      "AI suggestions support up to 100 summaries, 200 open tasks and 160,000 characters. Reduce the agenda context.",
                                  )
                                : job.errorCode === "AI_PROVIDER_API_ERROR"
                                  ? i18n(
                                        "The provider returned invalid agenda suggestions. Try again.",
                                    )
                                  : i18n(
                                        "Could not suggest points. Check the processing profile and try again.",
                                    )}
                        </span>
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy || !detail.aiSuggestions.available}
                            onClick={suggest}
                        >
                            {i18n("Try again")}
                        </Button>
                    </div>
                )}
                {canEdit && !live && suggestionsReason && (
                    <p
                        id={suggestionsReasonId}
                        className="text-xs text-muted-foreground"
                    >
                        {suggestionsReason}
                    </p>
                )}
                <OutlineEditor
                    showProposers={showAttribution}
                    detail={detail}
                    userId={userId}
                    readOnly={readOnly}
                    live={live}
                    pendingPaths={agenda.pendingPaths}
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
                            id: `pending-${nanoid()}`,
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
                            updatedByUserId: userId ?? null,
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
            </AgendaSection>
        </div>
    );
    const suggestions = detail.suggestions.filter(
        (suggestion) => suggestion.state === "open",
    );
    const meetingMetadata: ReactNode[] = [
        detail.timeSet && detail.plannedStart
            ? `${format.dateTime(new Date(detail.plannedStart), { dateStyle: "medium", timeStyle: "short" })}${detail.plannedEnd ? `–${format.dateTime(new Date(detail.plannedEnd), { timeStyle: "short" })}` : ""}`
            : i18n("No scheduled time"),
        detail.attachedRecording || detail.recordingItemId
            ? i18n("Recorded")
            : live
              ? i18n("In progress")
              : detail.state === "held"
                ? i18n("Agenda without recording")
                : i18n("Preparing"),
    ];
    if (detail.calendarEventId)
        meetingMetadata.push(
            detail.calendar?.htmlLink ? (
                <a
                    key="event"
                    href={detail.calendar.htmlLink}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                >
                    {i18n("Calendar event")}
                </a>
            ) : (
                i18n("Calendar event")
            ),
        );
    if (detail.invitees.length)
        meetingMetadata.push(
            `${i18n("Invitees")}: ${inviteeNames(detail.invitees)}`,
        );
    meetingMetadata.push(
        `${i18n("Editors")}: ${detail.authors.map((author) => author.name ?? i18n("Unknown author")).join(", ")}`,
    );
    return (
        <div className="space-y-4" data-agenda-variant={variant}>
            {variant !== "recording" && (
                <div className="space-y-3">
                    <ItemHeader
                        itemId={detail.meetingItemId ?? detail.id}
                        kind="meeting"
                        isOwn={detail.userId === userId}
                        shared={detail.shared}
                        sharingManageOnly={readOnly}
                        received={Boolean(detail.receivedShare)}
                        view={
                            detail.shared
                                ? "org"
                                : detail.userId !== userId
                                  ? "received"
                                  : undefined
                        }
                        ownerName={
                            detail.authors.find(
                                (author) => author.id === detail.userId,
                            )?.name
                        }
                        title={detail.title}
                        metadata={meetingMetadata}
                        readOnly
                        action={
                            <>
                                <AgendaExport detail={detail} disabled={busy} />
                                {(!detail.permissions.manage || readOnly) &&
                                    detail.calendarEventId &&
                                    detail.canExportCalendar !== false && (
                                        <AgendaCalendarExport
                                            detail={detail}
                                            disabled={busy}
                                        />
                                    )}
                                {detail.permissions.manage && !readOnly && (
                                    <MeetingSettings
                                        detail={detail}
                                        recordings={recordings}
                                        onSave={(change, optimistic) =>
                                            mutate(
                                                "",
                                                "PATCH",
                                                change,
                                                (value) => ({
                                                    ...value,
                                                    ...optimistic,
                                                }),
                                            ).then((saved) => {
                                                if (saved) onChanged?.();
                                                return saved;
                                            })
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
                                                return saved;
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
                            </>
                        }
                        folders={
                            <AgendaFolderTags
                                detail={
                                    detail.receivedShare
                                        ? {
                                              ...detail,
                                              folders: detail.folders.filter(
                                                  (folder) =>
                                                      folder.id !==
                                                          detail.receivedShare
                                                              ?.filingFolderId ||
                                                      detail.receivedFolders?.some(
                                                          (path) =>
                                                              path.id ===
                                                              folder.id,
                                                      ),
                                              ),
                                          }
                                        : detail
                                }
                                userId={userId}
                                folders={folders}
                                disabled={busy || readOnly}
                                mutate={mutate}
                                onChanged={onChanged}
                            />
                        }
                    />
                    {detail.receivedShare && (
                        <ReceivedItemBanner
                            readOnly={readOnly}
                            recording={{
                                id: detail.meetingItemId ?? detail.id,
                                filename: detail.title,
                                kind: "meeting",
                                ownerName: detail.authors.find(
                                    (author) => author.id === detail.userId,
                                )?.name,
                                receivedShare: detail.receivedShare,
                                receivedFolderIds: detail.receivedFolders?.map(
                                    (folder) => folder.id,
                                ),
                            }}
                            folders={folders}
                            shared={detail.shared}
                            onFiled={() => void agenda.reload().catch(() => {})}
                            onRemoved={() => {
                                onChanged?.();
                                if (
                                    !detail.shared &&
                                    !detail.receivedFolders?.length
                                )
                                    onDeleted?.();
                            }}
                        />
                    )}
                    {live && (
                        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-meeting/30 bg-meeting/5 p-3 text-sm">
                            <time className="font-mono tabular-nums">
                                {elapsed(detail.liveStartedAt, now)}
                            </time>
                            <span>
                                {i18n(
                                    "{discussed, number} of {total, plural, one {# point discussed} other {# points discussed}} · {tasks, plural, one {# task changed} other {# tasks changed}}",
                                    {
                                        discussed,
                                        total: topLevelPoints.length,
                                        tasks: changedCount,
                                    },
                                )}
                            </span>
                        </div>
                    )}
                    {!readOnly && detail.state === "held" && (
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
                </div>
            )}
            {detail.attachedRecording?.visible === false && (
                <output className="block rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                    {i18n(
                        "This agenda went with the recording. You'll see the recording once its author shares it.",
                    )}
                </output>
            )}
            {!!detail.recordingBy?.length && (
                <p className="text-sm text-muted-foreground">
                    {i18n("Recording this meeting: {names}", {
                        names: detail.recordingBy
                            .map(
                                (person) =>
                                    person.name ?? i18n("Unknown author"),
                            )
                            .join(", "),
                    })}
                </p>
            )}
            {agenda.colleagueChange && (
                <output className="fixed right-4 bottom-4 z-50 flex max-w-md items-center justify-between rounded-lg border bg-background p-3 text-sm shadow-lg">
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
            {agenda.conflict && (
                <p role="alert" className="text-sm">
                    {i18n(
                        "Someone else changed this agenda. Your input is kept. Review their changes and try again.",
                    )}
                </p>
            )}
            {agenda.error && (
                <p role="alert" className="text-sm">
                    {agenda.error}
                </p>
            )}
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
                                            void mutate(
                                                "/suggestions",
                                                "PATCH",
                                                {
                                                    state: "dismissed",
                                                    kind: "ai",
                                                },
                                                (value) => ({
                                                    ...value,
                                                    suggestions:
                                                        value.suggestions.map(
                                                            (entry) =>
                                                                entry.kind ===
                                                                    "ai" &&
                                                                entry.state ===
                                                                    "open"
                                                                    ? {
                                                                          ...entry,
                                                                          state: "dismissed",
                                                                      }
                                                                    : entry,
                                                        ),
                                                }),
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
                                                    {i18n("Under: {point}", {
                                                        point:
                                                            detail.points.find(
                                                                (point) =>
                                                                    point.id ===
                                                                    suggestion.parentPointId,
                                                            )?.text ?? "",
                                                    })}
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
                                                                (recording) =>
                                                                    recording.id ===
                                                                    itemId,
                                                            )?.filename ??
                                                                i18n(
                                                                    "Source item",
                                                                )}
                                                        </Link>
                                                    ),
                                                )}
                                                {suggestion.sources?.taskIds?.map(
                                                    (taskId) => {
                                                        const text =
                                                            detail.suggestionTasks?.find(
                                                                (task) =>
                                                                    task.id ===
                                                                    taskId,
                                                            )?.text ??
                                                            detail.tasks.find(
                                                                (task) =>
                                                                    task.id ===
                                                                    taskId,
                                                            )?.text;
                                                        return (
                                                            <Link
                                                                className="text-tasks underline"
                                                                key={taskId}
                                                                href="/tasks"
                                                                title={text}
                                                            >
                                                                {text
                                                                    ? text.length >
                                                                      40
                                                                        ? `${text.slice(0, 40)}…`
                                                                        : text
                                                                    : i18n(
                                                                          "Source task",
                                                                      )}
                                                            </Link>
                                                        );
                                                    },
                                                )}
                                            </div>
                                        </div>
                                        {(["added", "dismissed"] as const).map(
                                            (state) => (
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
                                            ),
                                        )}
                                    </div>
                                ))}
                            </section>
                        )
                    );
                })}
            {attachOpen && (
                <AttachRecordingDialog
                    detail={detail}
                    userId={userId}
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

function AgendaTaskRow({
    task,
    canEdit,
    live,
    pending,
    changed,
    onRemove,
    onNote,
    agendaId,
    collaborative,
    attribution,
    showAttribution,
    orderActions,
    ...rowProps
}: Omit<ComponentProps<typeof TaskRow>, "task"> & {
    task: MeetingTask;
    canEdit: boolean;
    live: boolean;
    pending: boolean;
    changed: boolean;
    onRemove: () => void;
    onNote: (note: string | null) => Promise<boolean>;
    agendaId: string;
    collaborative: boolean;
    attribution?: string | null;
    showAttribution: boolean;
    orderActions?: ReactNode;
}) {
    const i18n = useExtracted();
    const [noteOpen, setNoteOpen] = useState(false);
    const noteTrigger = useRef<HTMLButtonElement>(null);
    const restoreNoteFocus = useRef(false);
    const closeNote = () => {
        restoreNoteFocus.current = true;
        setNoteOpen(false);
    };
    useEffect(() => {
        if (!noteOpen && !pending && restoreNoteFocus.current) {
            restoreNoteFocus.current = false;
            noteTrigger.current?.focus();
        }
    }, [noteOpen, pending]);
    return (
        <TaskRow
            {...rowProps}
            task={task}
            pending={pending}
            readOnlyCheckbox
            notesReadOnly={live}
            badges={
                <>
                    {task.agendaOrigin === "older" && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs">
                            <History className="size-3" aria-hidden="true" />
                            {i18n("Older")}
                        </span>
                    )}
                    {changed && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs">
                            <PencilLine className="size-3" aria-hidden="true" />
                            {i18n("Changed during the meeting")}
                        </span>
                    )}
                    {showAttribution && (
                        <AgendaAttribution
                            name={attribution}
                            at={taskAttribution(task).at}
                        />
                    )}
                </>
            }
            extraNotes={
                noteOpen && canEdit ? (
                    <AgendaTaskNote
                        task={task}
                        agendaId={agendaId}
                        collaborative={collaborative}
                        saving={pending}
                        onCancel={closeNote}
                        onSave={async (note) => {
                            if (await onNote(note)) closeNote();
                        }}
                    />
                ) : task.agendaNote ? (
                    <div className="flex gap-2 border-l-2 border-border pl-3">
                        <MessageSquareText
                            className="mt-1 size-3 shrink-0"
                            aria-hidden="true"
                        />
                        <div>
                            <p className="whitespace-pre-wrap">
                                {task.agendaNote}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {i18n("Meeting note")}
                            </p>
                        </div>
                    </div>
                ) : null
            }
            actions={
                <>
                    {orderActions}
                    {canEdit && (live || task.agendaNote) && (
                        <ActionTooltip label={i18n("Meeting note")}>
                            <InlineEditorTrigger
                                ref={noteTrigger}
                                open={noteOpen}
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                disabled={pending}
                                aria-label={i18n("Meeting note")}
                                className="text-muted-foreground hover:text-foreground"
                                onClick={() => setNoteOpen(true)}
                            >
                                <MessageSquareText
                                    className="size-3"
                                    aria-hidden="true"
                                />
                            </InlineEditorTrigger>
                        </ActionTooltip>
                    )}
                    {canEdit && (
                        <ActionTooltip label={i18n("Remove from agenda")}>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                disabled={pending}
                                aria-label={i18n("Remove {task} from agenda", {
                                    task: task.text,
                                })}
                                className="text-muted-foreground hover:text-foreground"
                                onClick={onRemove}
                            >
                                <ListX className="size-3" aria-hidden="true" />
                            </Button>
                        </ActionTooltip>
                    )}
                </>
            }
        />
    );
}

function AgendaTaskNote({
    task,
    saving,
    onCancel,
    onSave,
    agendaId,
    collaborative,
}: {
    task: MeetingTask;
    saving: boolean;
    onCancel: () => void;
    onSave: (note: string | null) => Promise<void>;
    agendaId: string;
    collaborative: boolean;
}) {
    const i18n = useExtracted();
    const [draft, setDraft] = useState(task.agendaNote ?? "");
    const input = useRef<HTMLTextAreaElement>(null);
    const textSync = useAgendaText(
        input,
        agendaId,
        `task:${task.id}:note`,
        collaborative,
        task.agendaVersion ?? 0,
        setDraft,
    );
    useEffect(() => input.current?.focus(), []);
    return (
        <div className="space-y-2">
            <Textarea
                autoGrow
                ref={input}
                aria-label={i18n("Meeting note for {task}", {
                    task: task.text,
                })}
                className="min-h-20 max-h-[50vh]"
                value={draft}
                maxLength={2000}
                onChange={(event) => setDraft(event.target.value)}
            />
            <EditorActions
                cancelLabel={textSync.enabled ? i18n("Close") : i18n("Cancel")}
                saveLabel={i18n("Save")}
                saving={saving}
                onCancel={onCancel}
                onSave={() => {
                    if (textSync.enabled)
                        void textSync.flush().then((saved) => {
                            if (saved) onCancel();
                        });
                    else void onSave(draft.trim() || null);
                }}
            />
        </div>
    );
}

function AgendaSection({
    recording,
    divider = false,
    ...props
}: WorkflowWidgetProps & { recording: boolean; divider?: boolean }) {
    if (!recording) return <WorkflowWidget {...props} />;
    return (
        <section className={cn("space-y-3", divider && "border-t pt-4")}>
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{props.title}</h3>
                {props.headerAction}
            </div>
            {props.children}
        </section>
    );
}
