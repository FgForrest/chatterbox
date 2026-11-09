"use client";

import { CalendarClock, Unlink } from "lucide-react";
import { useRouter } from "next/navigation";
import { useExtracted, useFormatter } from "next-intl";
import {
    type ReactNode,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";
import { toast } from "sonner";
import { ProvenanceLine } from "@/components/pipeline/provenance-line";
import {
    WorkflowWidget,
    WorkflowWidgetLine,
} from "@/components/pipeline/workflow-widget";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionTooltip } from "@/components/ui/tooltip";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";
import { AgendaBody } from "./agenda-body";
import { meetingRequest } from "./api";
import {
    AttachmentAudience,
    AttachmentFilingNotice,
    AttachmentShareChoice,
    useAgendaAttachment,
} from "./attachment-disclosure";
import { CreateMeetingDialog } from "./create-meeting-dialog";
import {
    type AgendaSummaryState,
    RecordingAgendaContext,
} from "./recording-agenda-context";
import { RecordingShareBanner } from "./recording-share-banner";
import type { AgendaCandidate, MeetingDetail, NextMeeting } from "./types";
import { useAgendaCollapse } from "./use-agenda-collapse";

export function RecordingAgenda({
    recording,
    folders,
    folderId,
    userId,
    onChanged,
    children,
}: {
    recording: Recording;
    folders: RecordingFolder[];
    folderId?: string;
    userId?: string;
    onChanged: () => void;
    children?: (parts: {
        agenda: ReactNode;
        nextMeeting: ReactNode;
    }) => ReactNode;
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    const router = useRouter();
    const [summaryState, setSummaryState] = useState<AgendaSummaryState | null>(
        null,
    );
    const reportSummary = useCallback((state: AgendaSummaryState | null) => {
        setSummaryState(
            (previous) =>
                state ?? (previous ? { ...previous, disabled: true } : null),
        );
    }, []);
    const presence =
        summaryState?.itemId === recording.id
            ? summaryState.presence
            : undefined;
    const hasAgenda = presence?.hasAgenda ?? recording.hasAgenda ?? false;
    const candidateCount =
        presence?.agendaCandidateCount ?? recording.agendaCandidateCount ?? 0;
    const [attached, setAttached] = useState<MeetingDetail | null>(null);
    const [candidates, setCandidates] = useState<AgendaCandidate[]>([]);
    const [next, setNext] = useState<NextMeeting["event"]>(null);
    const [chosen, setChosen] = useState("");
    const { choice, attach: attachChosen } = useAgendaAttachment(
        chosen,
        recording.id,
        userId,
    );
    const [dismissed, setDismissed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [prepareOpen, setPrepareOpen] = useState(false);
    const summaryWasWorking = useRef(false);
    const [itemId, setItemId] = useState(recording.id);
    const currentItemId = useRef(recording.id);
    currentItemId.current = recording.id;
    if (itemId !== recording.id) {
        summaryWasWorking.current = false;
        setItemId(recording.id);
        setSummaryState(null);
        setAttached(null);
        setCandidates([]);
        setNext(null);
        setChosen("");
        setDismissed(false);
        setBusy(false);
        setPrepareOpen(false);
    }
    const own =
        recording.isOwn !== false &&
        recording.view !== "received" &&
        recording.view !== "org";
    const load = useCallback(
        async (signal?: AbortSignal, attachedOverride?: boolean) => {
            const loadAttached = attachedOverride ?? hasAgenda;
            const [agendaResult, candidatesResult, nextResult] =
                await Promise.allSettled([
                    loadAttached
                        ? meetingRequest<{ agenda: MeetingDetail | null }>(
                              `/api/recordings/${encodeURIComponent(recording.id)}/agenda`,
                              "GET",
                              undefined,
                              signal,
                          )
                        : Promise.resolve({ agenda: null }),
                    own && !loadAttached && candidateCount > 0
                        ? meetingRequest<{ candidates: AgendaCandidate[] }>(
                              `/api/recordings/${encodeURIComponent(recording.id)}/agenda-candidates`,
                              "GET",
                              undefined,
                              signal,
                          )
                        : Promise.resolve({ candidates: [] }),
                    loadAttached
                        ? meetingRequest<NextMeeting>(
                              `/api/recordings/${encodeURIComponent(recording.id)}/next-meeting`,
                              "GET",
                              undefined,
                              signal,
                          )
                        : Promise.resolve({ event: null }),
                ]);
            if (signal?.aborted || currentItemId.current !== recording.id)
                return;
            setAttached(
                agendaResult.status === "fulfilled" &&
                    agendaResult.value.agenda?.recordingItemId
                    ? agendaResult.value.agenda
                    : null,
            );
            setCandidates(
                candidatesResult.status === "fulfilled"
                    ? candidatesResult.value.candidates
                    : [],
            );
            setNext(
                nextResult.status === "fulfilled"
                    ? nextResult.value.event
                    : null,
            );
        },
        [recording.id, own, hasAgenda, candidateCount],
    );
    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [load]);
    useEffect(() => {
        if (summaryState?.working === undefined) return;
        if (summaryWasWorking.current && !summaryState.working && hasAgenda)
            void load();
        summaryWasWorking.current = summaryState.working;
    }, [summaryState?.working, hasAgenda, load]);
    async function attach() {
        if (!chosen) return;
        const previous = candidates;
        setBusy(true);
        setCandidates([]);
        try {
            if (await attachChosen(i18n("Could not attach the agenda"))) {
                if (currentItemId.current !== recording.id) return;
                await load(undefined, true);
                onChanged();
            } else if (currentItemId.current === recording.id)
                setCandidates(previous);
        } finally {
            if (currentItemId.current === recording.id) setBusy(false);
        }
    }
    async function detach() {
        const previous = attached;
        setAttached(null);
        setBusy(true);
        try {
            await meetingRequest(
                `/api/recordings/${encodeURIComponent(recording.id)}/agenda/detach`,
                "POST",
            );
            if (currentItemId.current !== recording.id) return;
            onChanged();
            await load(undefined, false);
        } catch {
            if (currentItemId.current !== recording.id) return;
            setAttached(previous);
            toast.error(i18n("Could not detach the agenda"));
        } finally {
            if (currentItemId.current === recording.id) setBusy(false);
        }
    }
    const notice = !attached && candidates.length > 0 && !dismissed && (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <CalendarClock className="size-4 text-muted-foreground" />
                    {i18n("Attach an agenda?")}
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                    {i18n(
                        "The recording overlaps events with prepared agendas.",
                    )}
                </p>
            </CardHeader>
            <CardContent className="space-y-3">
                <fieldset className="space-y-2">
                    <legend className="sr-only">
                        {i18n("Choose an agenda")}
                    </legend>
                    {candidates.map((candidate) => (
                        <label
                            key={candidate.id}
                            className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:checked]:border-primary"
                        >
                            <input
                                type="radio"
                                name={`candidate-${recording.id}`}
                                checked={chosen === candidate.id}
                                onChange={() => setChosen(candidate.id)}
                                className="mt-1 accent-primary"
                            />
                            <span className="min-w-0 text-sm">
                                <span className="block font-medium">
                                    {candidate.title}
                                </span>
                                <span className="block text-xs text-muted-foreground">
                                    {candidate.start &&
                                        format.dateTime(
                                            new Date(candidate.start),
                                            {
                                                dateStyle: "medium",
                                                timeStyle: "short",
                                            },
                                        )}{" "}
                                    ·{" "}
                                    {format.list(
                                        candidate.folders.map(
                                            (folder) => folder.name,
                                        ),
                                    )}{" "}
                                    ·{" "}
                                    {i18n("{minutes, number} min overlap", {
                                        minutes: Math.round(
                                            candidate.overlapMs / 60000,
                                        ),
                                    })}
                                </span>
                                {candidate.widensSharing && (
                                    <AttachmentAudience
                                        audience={candidate.audience}
                                    />
                                )}
                            </span>
                        </label>
                    ))}
                </fieldset>
                <AttachmentFilingNotice />
                <AttachmentShareChoice choice={choice} />
                <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setDismissed(true)}>
                        {i18n("No, thanks")}
                    </Button>
                    <Button
                        disabled={!chosen || busy}
                        onClick={() => void attach()}
                    >
                        {i18n("Attach agenda")}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
    const card = attached ? (
        <AttachedAgenda
            key={attached.id}
            attached={attached}
            own={own}
            busy={busy}
            onDetach={() => void detach()}
            recordingId={recording.id}
            userId={userId}
            folders={folders}
            summaryState={summaryState}
        />
    ) : (
        notice
    );
    const nextMeeting = attached && next && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
            <p>
                {i18n("Next meeting: {time}", {
                    time: format.dateTime(new Date(next.start), {
                        dateStyle: "medium",
                        timeStyle: "short",
                    }),
                })}
            </p>
            <Button
                variant="outline"
                size="sm"
                onClick={() => {
                    if (next.agendaId)
                        router.push(
                            `/dashboard?meeting=${encodeURIComponent(next.agendaId)}`,
                        );
                    else setPrepareOpen(true);
                }}
            >
                {i18n("Prepare next agenda")}
            </Button>
        </div>
    );
    return (
        <RecordingAgendaContext.Provider value={reportSummary}>
            {children ? (
                children({ agenda: card, nextMeeting })
            ) : (
                <>
                    {card}
                    {nextMeeting}
                </>
            )}
            {prepareOpen && next && (
                <CreateMeetingDialog
                    folders={folders}
                    folderId={folderId ?? attached?.folders[0]?.id}
                    eventId={next.id}
                    open
                    onOpenChange={setPrepareOpen}
                    onCreated={(id) => {
                        onChanged();
                        router.push(
                            `/dashboard?meeting=${encodeURIComponent(id)}`,
                        );
                    }}
                />
            )}
        </RecordingAgendaContext.Provider>
    );
}

function AttachedAgenda({
    attached,
    own,
    busy,
    onDetach,
    recordingId,
    userId,
    folders,
    summaryState,
}: {
    attached: MeetingDetail;
    own: boolean;
    busy: boolean;
    onDetach: () => void;
    recordingId: string;
    userId?: string;
    folders: RecordingFolder[];
    summaryState: AgendaSummaryState | null;
}) {
    const i18n = useExtracted();
    const [collapsed, toggle] = useAgendaCollapse(
        attached.id,
        "recording",
        true,
    );
    const points = attached.points.filter((point) => !point.parentId);
    const discussed = points.filter((point) => point.discussedAt).length;
    const tasks = attached.tasks.filter((task) => !task.removedAt).length;
    const title = attached.agendaTitle ?? attached.title;
    const pointCount = i18n(
        "{discussed, number} of {total, number} discussed",
        { discussed, total: points.length },
    );
    const taskCount = i18n("{count, plural, one {# task} other {# tasks}}", {
        count: tasks,
    });
    const detachAction = own && (
        <ActionTooltip label={i18n("Detach agenda")}>
            <AlertDialogTrigger asChild>
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={i18n("Detach agenda")}
                    disabled={busy}
                >
                    <Unlink className="size-4" aria-hidden="true" />
                </Button>
            </AlertDialogTrigger>
        </ActionTooltip>
    );
    return (
        <AlertDialog>
            <WorkflowWidget
                id={`recording-agenda-${attached.id}`}
                frame="inline"
                tone="quiet"
                title={i18n("Agenda")}
                collapsed={collapsed}
                onCollapse={toggle}
                collapseLabel={i18n("Collapse agenda")}
                expandLabel={i18n("Expand agenda")}
                headerAction={collapsed ? undefined : detachAction}
                inlineLine={
                    collapsed ? (
                        <WorkflowWidgetLine
                            title={i18n("Agenda")}
                            facts={`${title} · ${i18n("{discussed, number} of {total, plural, one {# point discussed} other {# points discussed}} · {tasks, plural, one {# task} other {# tasks}}", { discussed, total: points.length, tasks })}`}
                            icon={
                                <CalendarClock
                                    className="size-4 shrink-0 text-muted-foreground"
                                    aria-hidden="true"
                                />
                            }
                            onExpand={toggle}
                            expandLabel={i18n("Expand agenda")}
                            action={detachAction}
                        />
                    ) : undefined
                }
                footer={{
                    actions: null,
                    status: (
                        <ProvenanceLine
                            items={[
                                { key: "title", content: title },
                                { key: "discussed", content: pointCount },
                                { key: "tasks", content: taskCount },
                            ]}
                        />
                    ),
                }}
                bodyClassName="space-y-4"
            >
                {own && (
                    <RecordingShareBanner
                        agendaId={attached.id}
                        title={title}
                        recordingId={recordingId}
                        userId={userId}
                    />
                )}
                {summaryState?.hasSummary && !attached.outcomeSummaryId && (
                    <p className="text-xs text-muted-foreground">
                        {i18n(
                            "This summary was made before the agenda was attached.",
                        )}{" "}
                        <Button
                            variant="ghost"
                            size="sm"
                            disabled={summaryState.disabled}
                            onClick={summaryState.run}
                        >
                            {i18n("Re-summarize")}
                        </Button>
                    </p>
                )}
                <AgendaBody
                    id={attached.id}
                    variant="recording"
                    initial={attached}
                    userId={userId}
                    folders={folders}
                />
            </WorkflowWidget>
            {own && (
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {i18n("Detach agenda")}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {i18n(
                                "Detaching restores the standalone agenda. Existing summaries and actual task changes remain.",
                            )}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{i18n("Cancel")}</AlertDialogCancel>
                        <AlertDialogAction disabled={busy} onClick={onDetach}>
                            {i18n("Detach")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            )}
        </AlertDialog>
    );
}
