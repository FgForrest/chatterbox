"use client";

import { AlertTriangle, GraduationCap, Loader2 } from "lucide-react";
import { useExtracted } from "next-intl";
import {
    type ReactNode,
    useCallback,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
} from "react";
import { toast } from "sonner";
import { HelpLink } from "@/components/help/help-button";
import {
    type CalendarChoice,
    calendarChoiceFor,
} from "@/components/learn/calendar-choice";
import {
    type LearnMarks,
    learnMarksFrom,
} from "@/components/learn/learn-marks";
import {
    LearnResults,
    learnedCount,
    useLearnFailure,
    useSkipReason,
} from "@/components/learn/learn-results";
import { LearnWorkflowLine } from "@/components/learn/learn-workflow-line";
import {
    linkedRecordId,
    NewRecordItem,
    type NewRecordView,
    newRecordAs,
} from "@/components/learn/new-record-item";
import { announceLearnReviewsChanged } from "@/components/learn/review-events";
import {
    handleLearnReviewFailure,
    LearnEvidence,
    LearnReviewRow,
    useLearnFinishFooter,
} from "@/components/learn/review-parts";
import {
    ReviewSpeaker,
    type ReviewSpeakerPerson,
} from "@/components/learn/review-speaker";
import { speakerAccent } from "@/components/people/speaker-accents";
import { SpeakerPicker } from "@/components/people/speaker-picker";
import { WorkflowWidget } from "@/components/pipeline/workflow-widget";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { getApiErrorMessage } from "@/lib/api-errors";
import { followJob } from "@/lib/jobs/client";
import {
    labelsFromTurns,
    speakerKey,
} from "@/lib/knowledge/speaker-label-rules";
import type {
    MailNewRecordPayload,
    MailPhrasePayload,
    MailTextAnchor,
} from "@/lib/learn/mail-candidates";
import { refsIn } from "@/lib/learn/new-refs";
import type { MailDetail } from "@/lib/mail/detail";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";
import type { WorkflowWidgetFrame } from "@/lib/pipeline/workflow-widgets";
import type { RecordingView } from "@/lib/sharing/view";
import { withRecordingView } from "@/lib/sharing/view";
import { formatClock } from "@/lib/topics/timeline";
import { formatSpeakerLabel } from "@/lib/transcription/diarization";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { cn } from "@/lib/utils";

type Target =
    | { personId: string }
    | { entityId: string }
    /** A person or thing the same review proposes to add. */
    | { newRef: string };
type Side = Target | { speakerLabel: string } | { literal: string };

interface SpeakerPayload {
    label: string;
    personId: string | null;
    newRef?: string;
    evidenceMs: number[];
    reason: string;
    onlyFirstName?: boolean;
    recorder?: boolean;
}

/** A speaker item's payload. */
function speakerPayload(item: ItemView): SpeakerPayload {
    return item.payload as unknown as SpeakerPayload;
}

/** A group's tick-all checkbox: whether all, some or none are ticked. */
interface GroupToggle {
    state: "all" | "some" | "none";
    disabled: boolean;
    label: string;
    onToggle: () => void;
}

interface ItemView {
    id: string;
    kind:
        | "new_record"
        | "speaker"
        | "correction"
        | "known_fact"
        | "fact"
        | "relation_phrase";
    preTicked: boolean;
    decision: "accepted" | "rejected" | null;
    choice: Record<string, unknown> | null;
    version: number;
    dependsOnLabel: string | null;
    /** Once the review is finished: what became of it. */
    outcome?: string | null;
    // The shape follows the kind; read field by field below.
    payload: Record<string, unknown>;
}

interface ReviewState {
    run: { id: string; status: string; errorCode?: string | null } | null;
    items: ItemView[];
    /** A finished run that found nothing: what it had to go on. */
    known?: { people: number; things: number };
    names: Record<string, string>;
    types: Record<string, string>;
    relations: Record<string, string>;
    /** The types a new thing may take. */
    entityTypes?: { key: string; label: string }[];
    available: boolean;
}

const POLL_MS = 3_000;

/**
 * Learn on a transcript or message, and review what it proposed: the button
 * that starts a run, and once it is ready the review with its two
 * defaults (pre-ticked: corrections a person confirmed before, known facts
 * mentioned again; everything else unticked). Drafts are kept on the server
 * as they are ticked; "Finish review" applies what is ticked and remembers
 * the rest. Once a run is over the button shows how it went (learned,
 * nothing new, failed) and opens what it did, with Re-learn. Only whoever
 * may change the recording in the view sees it.
 */
export function LearnWidget({
    kind = "audio",
    recordingId,
    view,
    source = "riffado",
    turns = [],
    mailDetail,
    onSeek,
    onPlaySpeaker,
    onFinished,
    onMarks,
    pollMs = POLL_MS,
    frame = "inline",
    widgetId,
    folderName,
    showTrigger = true,
    collapseReady = false,
}: {
    kind?: "audio" | "mail";
    recordingId: string;
    view?: RecordingView;
    source?: "plaud" | "riffado";
    turns?: readonly TranscriptTurn[];
    mailDetail?: MailDetail;
    onSeek?: (ms: number) => void;
    /** Play a speaker's next turn; false when it has none to play. */
    onPlaySpeaker?: (label: string) => boolean;
    /** The transcript's speakers and corrections changed: reload them. */
    onFinished?: () => void;
    /** The ready review's proposals, for the transcript to show in place. */
    onMarks?: (marks: LearnMarks | null) => void;
    /** How often a run found learning is looked at again. */
    pollMs?: number;
    frame?: WorkflowWidgetFrame;
    widgetId?: string;
    folderName?: string;
    showTrigger?: boolean;
    collapseReady?: boolean;
}) {
    const i18n = useExtracted();
    const sectionPrefix = useId();
    const [state, setState] = useState<ReviewState | null>(null);
    const [open, setOpen] = useState(false);
    const resolvedWidgetId = widgetId ?? `${kind}-learn-review-${recordingId}`;
    // The last run's results, once it is over.
    const [resultsOpen, setResultsOpen] = useState(false);
    const [running, setRunning] = useState(false);
    const [calendarChoices, setCalendarChoices] = useState<
        CalendarChoice[] | null
    >(null);
    const [calendarForget, setCalendarForget] = useState(false);
    const [finishing, setFinishing] = useState(false);
    // The speaker item someone else is being picked for.
    const [picking, setPicking] = useState<ItemView | null>(null);
    // Drafts on their way to the server: Finish waits for them, so what
    // it applies is what the person ticked.
    const [saving, setSaving] = useState(0);
    // The same drafts, for a Finish clicked before they re-rendered (a
    // name typed and Finish clicked at once).
    const drafts = useRef(new Set<Promise<unknown>>());
    // One item's drafts go one after another, each on the version the one
    // before it left (a name, then a type, changed at once).
    const queues = useRef(new Map<string, Promise<unknown>>());
    const versions = useRef(new Map<string, number>());
    // Drafts refused: a Finish waiting for them stops, and shows the
    // review as it is now instead.
    const refused = useRef(0);

    // Each transcript has its own review; mail has one review per message.
    const url = useCallback(
        (path: string) =>
            withRecordingView(
                `/api/recordings/${recordingId}/${path}${kind === "audio" ? `?source=${source}` : ""}`,
                view,
            ),
        [kind, recordingId, view, source],
    );

    const load = useCallback(async (): Promise<ReviewState | null> => {
        const response = await fetch(url("review"));
        if (!response.ok) return null;
        const next = (await response.json()) as ReviewState;
        versions.current = new Map(
            (next.items ?? []).map((item) => [item.id, item.version]),
        );
        setState(next);
        return next;
    }, [url]);

    useEffect(() => {
        void load();
    }, [load]);

    // A run this page did not start (another tab, a reload while it ran)
    // is followed here until it is ready or ends.
    const learningElsewhere =
        !running &&
        (state?.run?.status === "queued" || state?.run?.status === "running");
    useEffect(() => {
        if (!learningElsewhere) return;
        const timer = setInterval(() => void load(), pollMs);
        return () => clearInterval(timer);
    }, [learningElsewhere, load, pollMs]);

    const skipReason = useSkipReason();
    const failure = useLearnFailure();

    /** Start a run; `forget`: rejections on the recording go first. */
    const learn = async (forget = false, calendarEventId?: string) => {
        let selectedEventId = calendarEventId;
        if (
            kind === "audio" &&
            selectedEventId === undefined &&
            (!view || view === "private")
        ) {
            try {
                const result = await fetch(
                    `/api/recordings/${recordingId}/calendar-events`,
                );
                if (result.ok) {
                    const { events } = (await result.json()) as {
                        events: CalendarChoice[];
                    };
                    const choice = calendarChoiceFor(events);
                    if (choice.kind === "choose") {
                        setCalendarChoices([...choice.events]);
                        setCalendarForget(forget);
                        return;
                    }
                    selectedEventId =
                        choice.kind === "one" ? choice.eventId : undefined;
                }
            } catch {
                selectedEventId = undefined;
            }
        }
        setResultsOpen(false);
        setRunning(true);
        try {
            if (forget) {
                const forgotten = await fetch(
                    withRecordingView(
                        `/api/recordings/${recordingId}/review/dismissals`,
                        view,
                    ),
                    { method: "DELETE" },
                );
                if (!forgotten.ok) {
                    toast.error(
                        await getApiErrorMessage(
                            forgotten,
                            i18n("Could not forget the rejections"),
                        ),
                    );
                    return;
                }
            }
            const learnPath =
                kind === "audio"
                    ? `learn?source=${source}${selectedEventId ? `&calendarEventId=${encodeURIComponent(selectedEventId)}` : ""}`
                    : "learn";
            const response = await fetch(
                withRecordingView(
                    `/api/recordings/${recordingId}/${learnPath}`,
                    view,
                ),
                { method: "POST" },
            );
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(response, i18n("Learn failed")),
                );
                return;
            }
            invalidateItemProcessing(recordingId);
            const { jobId } = (await response.json()) as {
                jobId: string | null;
            };
            const job = jobId
                ? await followJob(jobId, { pollMs: POLL_MS })
                : null;
            const next = await load();
            // How it went, so a run that found nothing is not mistaken for
            // one that did not happen.
            const status = next?.run?.status;
            if (job?.status === "failed") {
                toast.error(job.error || i18n("Learn failed"));
            } else if (status === "failed") {
                toast.error(failure(next?.run?.errorCode));
            } else if (status === "ready") {
                toast.success(
                    i18n(
                        "Learn found {count, plural, one {# suggestion} other {# suggestions}} to review",
                        { count: next?.items.length ?? 0 },
                    ),
                );
            } else if (status === "finished") {
                toast.info(i18n("Learn found nothing new"));
            } else if (status === "superseded") {
                toast.warning(
                    kind === "mail"
                        ? i18n(
                              "The message changed while Learn ran. Run it again.",
                          )
                        : i18n(
                              "The transcript changed while Learn ran. Run it again.",
                          ),
                );
            } else if (status === "cancelled") {
                toast.warning(
                    i18n("Learn was stopped before it finished. Run it again."),
                );
            }
        } finally {
            setRunning(false);
        }
    };

    const ticked = (item: ItemView) =>
        (item.decision ?? (item.preTicked ? "accepted" : "rejected")) ===
        "accepted";

    const decide = (
        item: ItemView,
        decision: "accepted" | "rejected" | null,
        choice: Record<string, unknown> | null = item.choice,
    ): Promise<void> => {
        setSaving((count) => count + 1);
        const before = queues.current.get(item.id) ?? Promise.resolve();
        // After the save before it, however that went: one failure must
        // not swallow the edits made after it.
        const sent = before
            .catch(() => undefined)
            .then(() => keep(item, decision, choice))
            .finally(() => setSaving((count) => count - 1));
        queues.current.set(item.id, sent);
        drafts.current.add(sent);
        return sent.finally(() => {
            drafts.current.delete(sent);
            if (queues.current.get(item.id) === sent) {
                queues.current.delete(item.id);
            }
        });
    };

    const keep = async (
        item: ItemView,
        decision: "accepted" | "rejected" | null,
        choice: Record<string, unknown> | null,
    ) => {
        let response: Response;
        try {
            response = await fetch(url(`review/items/${item.id}`), {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    decision,
                    version: versions.current.get(item.id) ?? item.version,
                    choice,
                }),
            });
        } catch {
            // Offline: not kept, and Finish must not go ahead without it.
            refused.current++;
            toast.error(i18n("Could not keep that decision"));
            return;
        }
        if (!response.ok) {
            refused.current++;
            await handleLearnReviewFailure(
                response,
                i18n("Could not keep that decision"),
                load,
            );
            return;
        }
        const { version } = (await response.json()) as { version: number };
        versions.current.set(item.id, version);
        setState((current) =>
            current
                ? {
                      ...current,
                      items: current.items.map((other) =>
                          other.id === item.id
                              ? { ...other, decision, choice, version }
                              : other,
                      ),
                  }
                : current,
        );
    };

    /** Work on the items done outside the review: Finish waits for it. */
    const track = useCallback(function track<T>(work: Promise<T>): Promise<T> {
        setSaving((count) => count + 1);
        drafts.current.add(work);
        return work.finally(() => {
            drafts.current.delete(work);
            setSaving((count) => count - 1);
        });
    }, []);

    // The latest `decide`, for marks made from an earlier render.
    const decideRef = useRef(decide);
    decideRef.current = decide;
    useEffect(() => {
        if (kind !== "audio") return;
        onMarks?.(
            learnMarksFrom(
                state,
                async (itemId, decision, choice) => {
                    const item = state?.items.find(
                        (other) => other.id === itemId,
                    );
                    if (!item) return;
                    const kept = choice === undefined ? item.choice : choice;
                    await decideRef.current(item, decision, kept);
                    const linked = linkedRecordId(kept);
                    if (linked && !(linked in (state?.names ?? {}))) {
                        await load();
                    }
                },
                track,
            ),
        );
    }, [kind, state, onMarks, load, track]);
    useEffect(() => () => onMarks?.(null), [onMarks]);

    const finish = async () => {
        if (!state) return;
        setFinishing(true);
        try {
            // Drafts sent since the last render land first, and the review
            // is finished as they left it.
            let seen = state;
            if (drafts.current.size > 0) {
                const refusedBefore = refused.current;
                await Promise.allSettled([...drafts.current]);
                seen = (await load()) ?? state;
                // One was refused: the reviewer sees why, and finishes
                // again on the review as it is now.
                if (refused.current !== refusedBefore) return;
            }
            const response = await fetch(url("review/finish"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    versions: Object.fromEntries(
                        seen.items.map((item) => [item.id, item.version]),
                    ),
                }),
            });
            if (!response.ok) {
                await handleLearnReviewFailure(
                    response,
                    i18n("Could not finish the review"),
                    load,
                );
                return;
            }
            invalidateItemProcessing(recordingId);
            const result = (await response.json()) as {
                status: string;
                applied: number;
                skipped: { itemId: string; code?: string }[];
            };
            if (result.status === "superseded") {
                toast.error(
                    kind === "mail"
                        ? i18n(
                              "The message changed since Learn read it. Run Learn again.",
                          )
                        : i18n(
                              "The transcript changed since Learn read it. Run Learn again.",
                          ),
                );
            } else {
                toast.success(
                    i18n(
                        "Review finished: {count, plural, one {# change} other {# changes}} made",
                        { count: result.applied },
                    ),
                );
                for (const skipped of result.skipped) {
                    const item = state.items.find(
                        (other) => other.id === skipped.itemId,
                    );
                    toast.warning(
                        i18n("{item}: {why}", {
                            item: item ? describeItem(item) : "?",
                            why: skipReason(skipped.code),
                        }),
                    );
                }
            }
            setOpen(false);
            await load();
            announceLearnReviewsChanged();
            onFinished?.();
        } finally {
            setFinishing(false);
        }
    };

    const mailWords = useCallback(
        (anchor: MailTextAnchor | undefined): string | null => {
            if (!anchor || !mailDetail) return null;
            const segment = mailDetail.segments.find(
                (candidate) => candidate.index === anchor.segmentIndex,
            );
            return (
                segment?.text.slice(anchor.charStart, anchor.charEnd).trim() ??
                null
            );
        },
        [mailDetail],
    );
    const mailProvenance = (
        provenance: "quoted" | "unverified" | null | undefined,
    ): string | null => {
        if (provenance === "quoted") {
            return i18n(
                "Quoted from an earlier message: what its author wrote, not the sender",
            );
        }
        if (provenance === "unverified") {
            return i18n("From a sender nothing verified");
        }
        return null;
    };
    const newRecordView = useCallback(
        (item: ItemView): NewRecordView => {
            if (kind === "audio") {
                return item.payload as unknown as NewRecordView;
            }
            const payload = item.payload as unknown as MailNewRecordPayload;
            return { ...payload, evidenceMs: [] };
        },
        [kind],
    );

    // The new records of the review, by the ref other items use.
    const records = useMemo(
        () =>
            new Map(
                (state?.items ?? [])
                    .filter((item) => item.kind === "new_record")
                    .map((item) => [
                        (item.payload as unknown as NewRecordView).ref,
                        item,
                    ]),
            ),
        [state],
    );
    /** A new record's name as the reviewer left it, or the record it is. */
    const recordName = useCallback(
        (ref: string): string => {
            const item = records.get(ref);
            if (!item) return "?";
            const linked = linkedRecordId(item.choice);
            if (linked) return state?.names[linked] ?? "?";
            return newRecordAs(newRecordView(item), item.choice).name;
        },
        [newRecordView, records, state],
    );
    /** A side of a fact in words: a speaker by whom the review names. */
    function nameOf(side: Side | undefined): string {
        if (!side) return "?";
        if ("literal" in side) return `"${side.literal}"`;
        if ("speakerLabel" in side) {
            if (kind === "mail") {
                const participant = mailDetail?.participants.find(
                    (candidate) => candidate.ref === side.speakerLabel,
                );
                return (
                    participant?.name ??
                    participant?.address ??
                    side.speakerLabel
                );
            }
            return (
                namedSpeaker(side.speakerLabel) ??
                formatSpeakerLabel(side.speakerLabel)
            );
        }
        if ("newRef" in side) return recordName(side.newRef);
        const id = "personId" in side ? side.personId : side.entityId;
        return state?.names[id] ?? "?";
    }
    const turnStart = (turnIndex: number) => turns[turnIndex]?.startMs ?? 0;

    /** An item in a few words, as the review lists it. */
    function describeItem(item: ItemView): string {
        const payload = item.payload as Record<string, unknown>;
        switch (item.kind) {
            case "new_record":
                return recordName(String(payload.ref));
            case "speaker":
                return String(payload.label);
            case "correction":
                return `"${String(payload.heard)}"`;
            case "relation_phrase":
                return `"${String(payload.phrase)}"`;
            default: {
                const key = String(payload.relationKey);
                return `${nameOf(payload.subject as Side)} — ${state?.relations[key] ?? key} — ${nameOf(payload.object as Side)}`;
            }
        }
    }

    /** A finished item in a few words, with whom a speaker was named. */
    function describeResult(item: ItemView): string {
        const payload = item.payload as Record<string, unknown>;
        if (item.kind === "speaker") {
            const choice = item.choice;
            const person =
                choice && "unknown" in choice
                    ? i18n("unknown")
                    : choice && typeof choice.personId === "string"
                      ? (state?.names[choice.personId] ?? "?")
                      : choice && typeof choice.displayName === "string"
                        ? choice.displayName
                        : typeof payload.personId === "string"
                          ? (state?.names[payload.personId] ?? "?")
                          : typeof payload.newRef === "string"
                            ? recordName(payload.newRef)
                            : "?";
            return `${String(payload.label)} → ${person}`;
        }
        if (item.kind === "new_record") {
            const record = newRecordView(item);
            const kind =
                record.kind === "person"
                    ? i18n("Person")
                    : (state?.entityTypes?.find(
                          (type) =>
                              type.key ===
                              newRecordAs(record, item.choice).typeKey,
                      )?.label ??
                      newRecordAs(record, item.choice).typeKey ??
                      "");
            return `${recordName(record.ref)} (${kind})`;
        }
        if (item.kind === "correction") {
            const replacement =
                typeof payload.replacement === "string"
                    ? payload.replacement
                    : nameOf(payload.target as Side);
            return `"${String(payload.heard)}" → ${replacement}`;
        }
        return describeItem(item);
    }

    const groups = useMemo(() => {
        const items = state?.items ?? [];
        return {
            records: items.filter((item) => item.kind === "new_record"),
            speakers: items.filter((item) => item.kind === "speaker"),
            corrections: items.filter((item) => item.kind === "correction"),
            known: items.filter((item) => item.kind === "known_fact"),
            facts: items.filter((item) => item.kind === "fact"),
            phrases: items.filter((item) => item.kind === "relation_phrase"),
        };
    }, [state]);
    const speakerItems = useMemo(
        () =>
            new Map(
                groups.speakers.map((item) => [
                    speakerKey(speakerPayload(item).label),
                    item,
                ]),
            ),
        [groups],
    );
    // Colours by the order speakers first speak, as on the transcript.
    const speakingOrder = useMemo(() => labelsFromTurns(turns), [turns]);
    const accentOf = (label: string) =>
        speakerAccent(speakingOrder.indexOf(speakerKey(label)));

    const status = state?.run?.status;
    const ready = status === "ready";
    const finished = status === "finished";
    const failed = status === "failed";
    const count = state?.items?.length ?? 0;
    const selected = (state?.items ?? []).filter(ticked).length;
    const finishFooter = useLearnFinishFooter({
        selected,
        total: count,
        busy: finishing || saving > 0,
        onFinish: () => void finish(),
    });
    if (!state?.available && !ready && !finished && !failed) return null;
    const learned = finished ? learnedCount(state?.items ?? []) : 0;
    const pending = status === "queued" || status === "running";
    const working = running || pending;
    const buttonClass =
        "h-auto gap-1 px-0 text-sm font-medium hover:bg-transparent hover:text-primary";

    const seek = (ms: number, label?: string) => (
        <button
            type="button"
            className="font-mono text-xs text-primary hover:underline"
            onClick={() => onSeek?.(ms)}
            aria-label={i18n("Play from {time}", { time: formatClock(ms) })}
        >
            {label ?? `▸${formatClock(ms)}`}
        </button>
    );

    /** The new records an item refers to that are not ticked, by name. */
    const waitingFor = (item: ItemView): string[] => {
        const refs =
            item.kind === "speaker"
                ? // A speaker the reviewer named otherwise needs no record.
                  item.choice
                    ? []
                    : refsIn(item.payload)
                : refsIn(item.payload);
        return refs
            .filter((ref) => {
                const record = records.get(ref);
                return !record || !ticked(record);
            })
            .map(recordName);
    };

    /**
     * Whom a speaker item names: the reviewer's choice, else whom Learn
     * proposed; the review names every id in a choice once it is kept.
     */
    function speakerPerson(item: ItemView): ReviewSpeakerPerson {
        const payload = speakerPayload(item);
        const choice = item.choice;
        if (choice && "unknown" in choice) return { unknown: true };
        if (choice && typeof choice.personId === "string") {
            return { name: state?.names[choice.personId] ?? "?" };
        }
        if (choice && typeof choice.displayName === "string") {
            return { name: choice.displayName };
        }
        if (payload.personId) {
            const name = state?.names[payload.personId];
            return name ? { name } : null;
        }
        if (payload.newRef) return { name: recordName(payload.newRef) };
        return null;
    }

    /** Whom a speaker is once the review is finished, or null: nobody yet. */
    function namedSpeaker(label: string): string | null {
        const speaker = speakerItems.get(speakerKey(label));
        if (!speaker || !ticked(speaker) || waitingFor(speaker).length > 0) {
            return null;
        }
        const person = speakerPerson(speaker);
        return person && "name" in person ? person.name : null;
    }

    /**
     * Whether a fact waits for its speaker: one the review proposes to
     * name, and nobody ticked yet (or ticked as unknown).
     */
    const waitsForSpeaker = (item: ItemView) =>
        item.dependsOnLabel !== null &&
        speakerItems.has(speakerKey(item.dependsOnLabel)) &&
        namedSpeaker(item.dependsOnLabel) === null;

    /** Whether an item cannot be ticked now, for what it waits for. */
    const blockedItem = (item: ItemView): boolean => {
        switch (item.kind) {
            case "new_record":
                return item.decision === "rejected";
            case "speaker":
                return (
                    speakerPerson(item) === null || waitingFor(item).length > 0
                );
            case "correction":
                return waitingFor(item).length > 0;
            case "known_fact":
            case "fact":
                return waitsForSpeaker(item) || waitingFor(item).length > 0;
            default:
                // Relation phrases are decided by their buttons.
                return true;
        }
    };

    /**
     * How an item is unticked: a new record is only not proposed here
     * (rejected would be for good), the rest are rejected.
     */
    const untickedAs = (item: ItemView) =>
        item.kind === "new_record" ? null : "rejected";

    /** A group's tick-all: ticks every item that can be, or unticks them. */
    const groupToggle = (items: ItemView[], group: string): GroupToggle => {
        const open = items.filter((item) => !blockedItem(item));
        const all = open.length > 0 && open.every(ticked);
        let state: GroupToggle["state"] = "none";
        if (all) state = "all";
        else if (open.some(ticked)) state = "some";
        return {
            state,
            disabled: finishing || open.length === 0,
            label: all
                ? i18n("Untick all: {group}", { group })
                : i18n("Tick all: {group}", { group }),
            onToggle: () => {
                for (const item of open) {
                    if (ticked(item) !== all) continue;
                    void decide(item, all ? untickedAs(item) : "accepted");
                }
            },
        };
    };

    /** A side of a fact as shown: a speaker in its colour. */
    const sideNode = (side: Side | undefined): ReactNode => {
        if (!side || !("speakerLabel" in side)) return nameOf(side);
        const named = namedSpeaker(side.speakerLabel);
        return (
            <span
                className={`font-medium ${accentOf(side.speakerLabel).text} ${named ? "" : "italic"}`}
            >
                {named ?? formatSpeakerLabel(side.speakerLabel)}
            </span>
        );
    };

    /** "waits for …", under an item a new record holds up. */
    const waitsNote = (item: ItemView) => {
        const names = waitingFor(item);
        if (names.length === 0) return null;
        return (
            <div className="text-xs text-muted-foreground">
                {item.kind === "relation_phrase"
                    ? // The relation is made anyway; only its first fact
                      // needs the record.
                      i18n("its first fact waits for {names} to be added", {
                          names: names.join(", "),
                      })
                    : i18n("waits for {names} to be added", {
                          names: names.join(", "),
                      })}
            </div>
        );
    };

    const startLearn = () => {
        void learn();
    };
    let finishedTitle = i18n("Learn complete");
    let finishedFacts = i18n("Learned");
    let finishedTriggerLabel = i18n("Learned");
    let finishedIcon: ReactNode = <GraduationCap className="size-4" />;
    if (failed) {
        finishedTitle = i18n("Learn failed");
        finishedFacts = failure(state?.run?.errorCode);
        finishedTriggerLabel = i18n("Learn failed");
        finishedIcon = <AlertTriangle className="size-4 text-destructive" />;
    } else if (count === 0) {
        finishedFacts = i18n("Nothing was applied");
        finishedTriggerLabel = i18n("Learned: nothing new");
    } else if (learned === 0) {
        finishedFacts = i18n("Nothing was applied");
        finishedTriggerLabel = i18n("Learned: nothing applied");
    } else if (learned !== null) {
        finishedFacts = i18n(
            "{count, plural, one {# change applied} other {# changes applied}}",
            { count: learned },
        );
        finishedTriggerLabel = i18n("Learned ({count})", {
            count: String(learned),
        });
    }

    let trigger: ReactNode = null;
    if ((finished || failed) && !running) {
        if (showTrigger) {
            trigger = (
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={buttonClass}
                    onClick={() => setResultsOpen(true)}
                >
                    {finishedIcon}
                    {finishedTriggerLabel}
                </Button>
            );
        } else {
            trigger = (
                <LearnWorkflowLine
                    id={resolvedWidgetId}
                    title={finishedTitle}
                    facts={finishedFacts}
                    finished={finished}
                    failed={failed}
                    actionLabel={i18n("View results")}
                    onAction={() => setResultsOpen(true)}
                    onRetry={
                        failed && state?.available ? startLearn : undefined
                    }
                />
            );
        }
    } else if (!ready && !working) {
        if (showTrigger) {
            trigger = (
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={buttonClass}
                    disabled={running}
                    onClick={startLearn}
                >
                    {running ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <GraduationCap className="size-4" />
                    )}
                    {running ? i18n("Learning…") : i18n("Learn")}
                </Button>
            );
        } else {
            trigger = (
                <LearnWorkflowLine
                    id={resolvedWidgetId}
                    title={i18n("Learn")}
                    facts={
                        kind === "mail"
                            ? i18n(
                                  "Ready when you are. Review what the message can teach the Almanac.",
                              )
                            : i18n(
                                  "Ready when you are. Review what the transcript can teach the Almanac.",
                              )
                    }
                    tone="next"
                    actionLabel={i18n("Learn")}
                    onAction={startLearn}
                />
            );
        }
    } else if (showTrigger) {
        trigger = (
            <Button
                type="button"
                variant="ghost"
                size="sm"
                className={buttonClass}
                disabled={working}
                onClick={() => setOpen(true)}
            >
                {working ? (
                    <Loader2 className="size-4 animate-spin" />
                ) : (
                    <GraduationCap className="size-4" />
                )}
                {working
                    ? i18n("Learning…")
                    : i18n("Review ({count})", { count: String(count) })}
            </Button>
        );
    }

    let dialogLine: ReactNode = null;
    if (!showTrigger && working) {
        dialogLine = (
            <LearnWorkflowLine
                title={i18n("Learn")}
                facts={
                    kind === "mail"
                        ? i18n("Learn is reading the message")
                        : i18n("Learn is reading the transcript")
                }
                tone="working"
                working
            />
        );
    } else if (!showTrigger && ready) {
        dialogLine = (
            <LearnWorkflowLine
                title={i18n("Learn")}
                facts={i18n(
                    "{count, plural, one {# suggestion waits for your review} other {# suggestions wait for your review}}",
                    { count },
                )}
                tone="review"
                actionLabel={i18n("Review")}
                onAction={() => setOpen(true)}
            />
        );
    }

    const sections = [
        {
            key: "speakers",
            title: i18n("Speakers"),
            items: kind === "audio" ? groups.speakers : [],
        },
        {
            key: "records",
            title: i18n("New in the Almanac"),
            items: groups.records,
        },
        {
            key: "corrections",
            title: i18n("Corrections"),
            items: kind === "audio" ? groups.corrections : [],
        },
        {
            key: "known",
            title: i18n("Known facts mentioned again"),
            items: groups.known,
        },
        { key: "facts", title: i18n("New facts"), items: groups.facts },
        {
            key: "phrases",
            title: i18n("New kind of relation"),
            items: groups.phrases,
        },
    ].filter((section) => section.items.length > 0);
    const sectionProps = (key: string) => {
        const section = sections.find((section) => section.key === key);
        const items = section?.items ?? [];
        const title = section?.title ?? "";
        return {
            id: `${sectionPrefix}-${key}`,
            title,
            count: items.length,
            selected: items.filter(
                (item) =>
                    ticked(item) &&
                    (item.kind === "relation_phrase" || !blockedItem(item)),
            ).length,
            sticky: frame === "dialog",
            toggle: key === "phrases" ? undefined : groupToggle(items, title),
        };
    };
    const audioWords = (ms: number | undefined) =>
        ms === undefined
            ? undefined
            : turns.find((turn) => turn.startMs <= ms && turn.endMs > ms)?.text;

    return (
        <>
            <Dialog
                open={calendarChoices !== null}
                onOpenChange={(next) => {
                    if (!next) setCalendarChoices(null);
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {i18n("Choose a calendar event")}
                        </DialogTitle>
                        <DialogDescription>
                            {i18n(
                                "Choose the meeting connected to this recording. Invited people are possible names, not confirmed speakers.",
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-2">
                        {(calendarChoices ?? []).map((event) => (
                            <Button
                                key={event.id}
                                type="button"
                                variant="outline"
                                className="h-auto w-full justify-start whitespace-normal text-left"
                                onClick={() => {
                                    setCalendarChoices(null);
                                    void learn(calendarForget, event.id);
                                }}
                            >
                                {event.title} ·{" "}
                                {new Date(event.start).toLocaleString()}
                            </Button>
                        ))}
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                                setCalendarChoices(null);
                                void learn(calendarForget, "");
                            }}
                        >
                            {i18n("Continue without calendar")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            {trigger}
            {(ready || working) && (
                <WorkflowWidget
                    id={resolvedWidgetId}
                    frame={frame}
                    tone={working ? "working" : "review"}
                    open={open}
                    onOpenChange={setOpen}
                    title={
                        working
                            ? i18n("Learn")
                            : i18n("Review what Learn found")
                    }
                    helpLink={
                        working ? undefined : (
                            <HelpLink
                                topic="learn.review"
                                label={i18n("reviewing what Learn found")}
                            />
                        )
                    }
                    description={
                        working ? (
                            kind === "mail" ? (
                                i18n(
                                    "Learn is reading the message with your Almanac.",
                                )
                            ) : (
                                i18n(
                                    "Learn is reading the transcript with your Almanac.",
                                )
                            )
                        ) : (
                            <>
                                {kind === "mail"
                                    ? i18n(
                                          "What Learn found in this message. Ticked items are applied when you finish; unticked ones are not proposed again.",
                                      )
                                    : i18n(
                                          "What Learn found in this transcript. Ticked items are applied when you finish; unticked ones are not proposed again.",
                                      )}
                                {folderName ? ` · ${folderName}` : ""}
                            </>
                        )
                    }
                    footer={ready ? finishFooter : undefined}
                    closeLabel={
                        ready ? i18n("Save and continue later") : undefined
                    }
                    dialogWidth="3xl"
                    dialogLine={dialogLine}
                    inlineLine={
                        collapseReady && ready && !open ? dialogLine : undefined
                    }
                    bodyClassName={
                        working ? undefined : "@container/learn space-y-6"
                    }
                >
                    {working ? (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                            {frame === "inline"
                                ? i18n(
                                      "It continues in the background; you can leave this page.",
                                  )
                                : i18n(
                                      "It continues in the background; you can close this window.",
                                  )}
                        </p>
                    ) : (
                        <>
                            {sections.length >= 2 && (
                                <nav
                                    aria-label={i18n("Review sections")}
                                    className="flex flex-wrap gap-2"
                                >
                                    {sections.map((section) => (
                                        <button
                                            key={section.key}
                                            type="button"
                                            aria-controls={`${sectionPrefix}-${section.key}`}
                                            className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs hover:bg-muted"
                                            onClick={() =>
                                                scrollToSection(
                                                    `${sectionPrefix}-${section.key}`,
                                                )
                                            }
                                        >
                                            {section.title}{" "}
                                            <span className="tabular-nums text-muted-foreground">
                                                {section.items.length}
                                            </span>
                                        </button>
                                    ))}
                                </nav>
                            )}
                            {kind === "audio" && groups.speakers.length > 0 && (
                                <ReviewSection {...sectionProps("speakers")}>
                                    {groups.speakers.map((item) => {
                                        const payload = speakerPayload(item);
                                        const person = speakerPerson(item);
                                        const unknown = Boolean(
                                            person && "unknown" in person,
                                        );
                                        const playable =
                                            onPlaySpeaker &&
                                            turns.some(
                                                (turn) =>
                                                    speakerKey(turn.speaker) ===
                                                    speakerKey(payload.label),
                                            );
                                        return (
                                            <ReviewSpeaker
                                                key={item.id}
                                                label={payload.label}
                                                person={person}
                                                accent={accentOf(payload.label)}
                                                ticked={ticked(item)}
                                                blocked={blockedItem(item)}
                                                disabled={finishing}
                                                recorder={Boolean(
                                                    payload.recorder &&
                                                        !item.choice,
                                                )}
                                                onlyFirstName={Boolean(
                                                    payload.onlyFirstName &&
                                                        payload.personId,
                                                )}
                                                reason={payload.reason}
                                                evidence={payload.evidenceMs.map(
                                                    (ms) => (
                                                        <span
                                                            key={ms}
                                                            className="mr-1"
                                                        >
                                                            {seek(ms)}
                                                        </span>
                                                    ),
                                                )}
                                                waits={waitsNote(item)}
                                                onTick={(checked) =>
                                                    void decide(
                                                        item,
                                                        checked
                                                            ? "accepted"
                                                            : "rejected",
                                                    )
                                                }
                                                onPick={() => setPicking(item)}
                                                onUnknown={() =>
                                                    void (unknown
                                                        ? decide(
                                                              item,
                                                              "rejected",
                                                              null,
                                                          )
                                                        : decide(
                                                              item,
                                                              "accepted",
                                                              {
                                                                  unknown: true,
                                                              },
                                                          ))
                                                }
                                                onPlay={
                                                    playable
                                                        ? () =>
                                                              onPlaySpeaker(
                                                                  speakerKey(
                                                                      payload.label,
                                                                  ),
                                                              )
                                                        : undefined
                                                }
                                            />
                                        );
                                    })}
                                </ReviewSection>
                            )}
                            {groups.records.length > 0 && (
                                <ReviewSection {...sectionProps("records")}>
                                    {groups.records.map((item) => (
                                        <NewRecordItem
                                            key={item.id}
                                            payload={newRecordView(item)}
                                            choice={item.choice}
                                            ticked={ticked(item)}
                                            rejected={
                                                item.decision === "rejected"
                                            }
                                            disabled={finishing}
                                            names={state?.names ?? {}}
                                            entityTypes={
                                                state?.entityTypes ?? []
                                            }
                                            seek={(ms) => seek(ms)}
                                            quote={audioWords(
                                                newRecordView(item)
                                                    .evidenceMs[0],
                                            )}
                                            evidence={
                                                kind === "mail" ? (
                                                    <LearnEvidence
                                                        quote={mailWords(
                                                            (
                                                                item.payload as unknown as MailNewRecordPayload
                                                            ).evidence[0],
                                                        )}
                                                    >
                                                        <div className="text-xs text-muted-foreground">
                                                            {(
                                                                item.payload as unknown as MailNewRecordPayload
                                                            ).address ??
                                                                (
                                                                    item.payload as unknown as MailNewRecordPayload
                                                                ).reason}
                                                        </div>
                                                    </LearnEvidence>
                                                ) : undefined
                                            }
                                            onDecide={(decision, choice) =>
                                                decide(item, decision, choice)
                                            }
                                            onLinked={async (choice) => {
                                                await decide(
                                                    item,
                                                    "accepted",
                                                    choice,
                                                );
                                                // Names the record chosen.
                                                await load();
                                            }}
                                        />
                                    ))}
                                </ReviewSection>
                            )}
                            {kind === "audio" &&
                                groups.corrections.length > 0 && (
                                    <ReviewSection
                                        {...sectionProps("corrections")}
                                    >
                                        {groups.corrections.map((item) => {
                                            const payload = item.payload as {
                                                kind: "correct" | "link";
                                                heard: string;
                                                target: Target;
                                                replacement: string | null;
                                                anchors: {
                                                    turnIndex: number;
                                                }[];
                                            };
                                            return (
                                                <LearnReviewRow
                                                    key={item.id}
                                                    kind="correction"
                                                    checked={
                                                        ticked(item) &&
                                                        !blockedItem(item)
                                                    }
                                                    disabled={
                                                        blockedItem(item) ||
                                                        finishing
                                                    }
                                                    checkboxLabel={i18n(
                                                        "Correct {heard}",
                                                        {
                                                            heard: payload.heard,
                                                        },
                                                    )}
                                                    onCheckedChange={(
                                                        checked,
                                                    ) =>
                                                        void decide(
                                                            item,
                                                            checked
                                                                ? "accepted"
                                                                : "rejected",
                                                        )
                                                    }
                                                >
                                                    <div className="min-w-0">
                                                        "{payload.heard}" ×
                                                        {payload.anchors.length}{" "}
                                                        {payload.kind === "link"
                                                            ? `↔ ${nameOf(payload.target)} (${i18n("link, word kept")})`
                                                            : `→ ${payload.replacement ?? nameOf(payload.target)}`}{" "}
                                                        <div className="text-xs text-muted-foreground">
                                                            {payload.anchors
                                                                .slice(0, 3)
                                                                .map(
                                                                    (
                                                                        anchor,
                                                                        index,
                                                                    ) => (
                                                                        <span
                                                                            key={`${anchor.turnIndex}:${index}`}
                                                                            className="mr-1"
                                                                        >
                                                                            {seek(
                                                                                turnStart(
                                                                                    anchor.turnIndex,
                                                                                ),
                                                                            )}
                                                                        </span>
                                                                    ),
                                                                )}
                                                        </div>
                                                        {waitsNote(item)}
                                                    </div>
                                                </LearnReviewRow>
                                            );
                                        })}
                                    </ReviewSection>
                                )}
                            {[
                                {
                                    items: groups.known,
                                    title: i18n("Known facts mentioned again"),
                                },
                                {
                                    items: groups.facts,
                                    title: i18n("New facts"),
                                },
                            ].map(
                                (group) =>
                                    group.items.length > 0 && (
                                        <ReviewSection
                                            {...sectionProps(
                                                group.items === groups.known
                                                    ? "known"
                                                    : "facts",
                                            )}
                                            key={group.title}
                                        >
                                            {group.items.map((item) => {
                                                const payload =
                                                    item.payload as {
                                                        subject: Side;
                                                        relationKey: string;
                                                        object: Side;
                                                        startMs: number;
                                                        text?: MailTextAnchor;
                                                        provenance?:
                                                            | "quoted"
                                                            | "unverified"
                                                            | null;
                                                        replaces?: {
                                                            object: Side;
                                                        };
                                                    };
                                                const relation =
                                                    state?.relations[
                                                        payload.relationKey
                                                    ] ?? payload.relationKey;
                                                return (
                                                    <LearnReviewRow
                                                        key={item.id}
                                                        kind={
                                                            item.kind ===
                                                            "known_fact"
                                                                ? "known_fact"
                                                                : "fact"
                                                        }
                                                        checked={
                                                            ticked(item) &&
                                                            !blockedItem(item)
                                                        }
                                                        disabled={
                                                            blockedItem(item) ||
                                                            finishing
                                                        }
                                                        checkboxLabel={`${nameOf(payload.subject)} — ${relation} — ${nameOf(payload.object)}`}
                                                        onCheckedChange={(
                                                            checked,
                                                        ) =>
                                                            void decide(
                                                                item,
                                                                checked
                                                                    ? "accepted"
                                                                    : "rejected",
                                                            )
                                                        }
                                                    >
                                                        <div>
                                                            {sideNode(
                                                                payload.subject,
                                                            )}{" "}
                                                            — {relation} —{" "}
                                                            {sideNode(
                                                                payload.object,
                                                            )}
                                                            <LearnEvidence>
                                                                {kind ===
                                                                "mail" ? (
                                                                    <LearnEvidence
                                                                        quote={mailWords(
                                                                            payload.text,
                                                                        )}
                                                                        provenance={mailProvenance(
                                                                            payload.provenance,
                                                                        )}
                                                                    />
                                                                ) : (
                                                                    <div className="text-xs text-muted-foreground">
                                                                        {seek(
                                                                            payload.startMs,
                                                                        )}
                                                                    </div>
                                                                )}
                                                                {payload.replaces && (
                                                                    <div className="text-xs text-muted-foreground">
                                                                        {i18n(
                                                                            "replaces {value}",
                                                                            {
                                                                                value: nameOf(
                                                                                    payload
                                                                                        .replaces
                                                                                        .object,
                                                                                ),
                                                                            },
                                                                        )}
                                                                    </div>
                                                                )}
                                                                {item.dependsOnLabel &&
                                                                    waitsForSpeaker(
                                                                        item,
                                                                    ) && (
                                                                        <div className="text-xs text-muted-foreground">
                                                                            {i18n(
                                                                                "needs {label} named",
                                                                                {
                                                                                    label: formatSpeakerLabel(
                                                                                        item.dependsOnLabel,
                                                                                    ),
                                                                                },
                                                                            )}
                                                                        </div>
                                                                    )}
                                                                {waitsNote(
                                                                    item,
                                                                )}
                                                            </LearnEvidence>
                                                        </div>
                                                    </LearnReviewRow>
                                                );
                                            })}
                                        </ReviewSection>
                                    ),
                            )}
                            {groups.phrases.length > 0 && (
                                <ReviewSection {...sectionProps("phrases")}>
                                    {groups.phrases.map((item) => (
                                        <PhraseItem
                                            key={item.id}
                                            item={item}
                                            recordType={(ref) => {
                                                const record = records.get(ref);
                                                if (!record) return null;
                                                const payload =
                                                    newRecordView(record);
                                                return payload.kind === "person"
                                                    ? "person"
                                                    : newRecordAs(
                                                          payload,
                                                          record.choice,
                                                      ).typeKey;
                                            }}
                                            waits={waitsNote(item)}
                                            organization={view === "org"}
                                            types={state?.types ?? {}}
                                            describe={nameOf}
                                            evidence={
                                                kind === "mail" ? (
                                                    <LearnEvidence
                                                        quote={mailWords(
                                                            (
                                                                item.payload as unknown as MailPhrasePayload
                                                            ).text,
                                                        )}
                                                        provenance={mailProvenance(
                                                            (
                                                                item.payload as unknown as MailPhrasePayload
                                                            ).provenance,
                                                        )}
                                                    />
                                                ) : (
                                                    <LearnEvidence>
                                                        <div className="text-xs text-muted-foreground">
                                                            {typeof item.payload
                                                                .startMs ===
                                                                "number" &&
                                                                seek(
                                                                    item.payload
                                                                        .startMs,
                                                                )}
                                                        </div>
                                                    </LearnEvidence>
                                                )
                                            }
                                            onDecide={decide}
                                        />
                                    ))}
                                </ReviewSection>
                            )}
                        </>
                    )}
                </WorkflowWidget>
            )}
            {(finished || failed) && (
                <LearnResults
                    kind={kind}
                    open={resultsOpen}
                    onOpenChange={setResultsOpen}
                    status={failed ? "failed" : "finished"}
                    errorCode={state?.run?.errorCode ?? null}
                    items={state?.items ?? []}
                    known={state?.known}
                    describe={(item) => describeResult(item as ItemView)}
                    onRelearn={
                        state?.available
                            ? (forget) => void learn(forget)
                            : undefined
                    }
                />
            )}
            {picking && (
                <SpeakerPicker
                    label={(picking.payload as { label: string }).label}
                    organizationOnly={view === "org"}
                    onPick={async (chosen) => {
                        await decide(picking, "accepted", chosen);
                        // Names the person picked.
                        await load();
                        return true;
                    }}
                    onMarkUnknown={async () => {
                        await decide(picking, "accepted", { unknown: true });
                        return true;
                    }}
                    onClose={() => setPicking(null)}
                />
            )}
        </>
    );
}

function scrollToSection(id: string) {
    const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
    ).matches;
    document.getElementById(id)?.scrollIntoView({
        block: "start",
        behavior: reduceMotion ? "auto" : "smooth",
    });
}

function ReviewSection({
    id,
    title,
    count,
    selected,
    sticky,
    toggle,
    children,
}: {
    id: string;
    title: string;
    count: number;
    selected: number;
    sticky: boolean;
    toggle?: GroupToggle;
    children: ReactNode;
}) {
    const i18n = useExtracted();
    return (
        <section
            id={id}
            aria-labelledby={`${id}-title`}
            className={cn("space-y-2", !sticky && "scroll-mt-24")}
        >
            <div
                className={cn(
                    "flex flex-wrap items-center gap-2 bg-card py-2",
                    sticky && "sticky top-0 z-10",
                )}
            >
                {toggle && <GroupCheckbox {...toggle} />}
                <h3 id={`${id}-title`} className="text-sm font-semibold">
                    {title}
                </h3>
                <span className="text-xs tabular-nums text-muted-foreground">
                    {count}
                </span>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                    {i18n("{selected} of {total} selected", {
                        selected: String(selected),
                        total: String(count),
                    })}
                </span>
            </div>
            {children}
        </section>
    );
}

/** Ticks or unticks a whole section; half-ticked when only some are. */
function GroupCheckbox({ state, disabled, label, onToggle }: GroupToggle) {
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (ref.current) ref.current.indeterminate = state === "some";
    }, [state]);
    return (
        <input
            ref={ref}
            type="checkbox"
            className="size-4 shrink-0"
            checked={state === "all"}
            disabled={disabled}
            aria-label={label}
            title={label}
            onChange={onToggle}
        />
    );
}

/** A relation phrase: create it as the reviewer's own, suggest it, or dismiss it. */
function PhraseItem({
    item,
    recordType,
    waits,
    organization,
    types,
    describe,
    evidence,
    onDecide,
}: {
    item: ItemView;
    /** The type of a new record the review proposes, by its ref. */
    recordType: (ref: string) => string | null;
    /** What it waits for, when a new record holds it up. */
    waits: ReactNode;
    /**
     * On the Organization view: the relation is created as the
     * Organization's, and there is nobody to suggest it to.
     */
    organization: boolean;
    types: Record<string, string>;
    describe: (side: Side | undefined) => string;
    evidence?: ReactNode;
    onDecide: (
        item: ItemView,
        decision: "accepted" | "rejected",
        choice?: Record<string, unknown> | null,
    ) => Promise<void>;
}) {
    const i18n = useExtracted();
    const payload = item.payload as {
        phrase: string;
        subject: Side;
        /** Absent where it related to text, which is not kept. */
        object?: Side;
        objectKind: "entity" | "literal";
        count: number;
    };
    const [label, setLabel] = useState(payload.phrase);
    // One value at a time (a new one replaces it: "works for"), or many.
    const [cardinality, setCardinality] = useState<"one" | "many">("many");
    const typeOf = (side: Side): string | null => {
        if ("literal" in side) return null;
        if ("speakerLabel" in side) return "person";
        if ("newRef" in side) return recordType(side.newRef);
        return (
            types["personId" in side ? side.personId : side.entityId] ?? null
        );
    };
    const subjectType = typeOf(payload.subject);
    const objectType = payload.object ? typeOf(payload.object) : null;
    const chosen =
        item.decision === "accepted"
            ? (item.choice?.action as string | undefined)
            : item.decision === "rejected"
              ? "dismiss"
              : undefined;
    return (
        <LearnReviewRow kind="relation_phrase">
            <div className="space-y-1">
                <div>
                    "{payload.phrase}" ({payload.count}×):{" "}
                    {describe(payload.subject)} →{" "}
                    {payload.object ? describe(payload.object) : i18n("a text")}
                    {waits}
                    {evidence}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Input
                        className="h-8 w-56"
                        value={label}
                        aria-label={i18n("Name of the relation")}
                        onChange={(event) => setLabel(event.target.value)}
                    />
                    <NativeSelect
                        className="h-8"
                        aria-label={i18n("How many values")}
                        value={cardinality}
                        onChange={(event) =>
                            setCardinality(
                                event.target.value === "one" ? "one" : "many",
                            )
                        }
                    >
                        <option value="many">{i18n("Many values")}</option>
                        <option value="one">
                            {i18n("One value at a time")}
                        </option>
                    </NativeSelect>
                    <Button
                        size="sm"
                        variant={chosen === "create" ? "default" : "outline"}
                        disabled={!subjectType || !label.trim()}
                        onClick={() =>
                            void onDecide(item, "accepted", {
                                action: "create",
                                spec: {
                                    label: label.trim(),
                                    subjectTypes: [subjectType],
                                    objectTypes: objectType ? [objectType] : [],
                                    objectKind: objectType
                                        ? "entity"
                                        : "literal",
                                    cardinality,
                                },
                            })
                        }
                    >
                        {organization
                            ? i18n("Create as an Organization relation")
                            : i18n("Create as my relation")}
                    </Button>
                    {!organization && (
                        <Button
                            size="sm"
                            variant={
                                chosen === "suggest" ? "default" : "outline"
                            }
                            onClick={() =>
                                void onDecide(item, "accepted", {
                                    action: "suggest",
                                })
                            }
                        >
                            {i18n("Suggest to Organization")}
                        </Button>
                    )}
                    <Button
                        size="sm"
                        variant={chosen === "dismiss" ? "default" : "outline"}
                        onClick={() => void onDecide(item, "rejected", null)}
                    >
                        {i18n("Dismiss")}
                    </Button>
                </div>
            </div>
        </LearnReviewRow>
    );
}
