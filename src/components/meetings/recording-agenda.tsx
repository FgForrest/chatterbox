"use client";

import { CalendarClock } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";
import { AgendaBody } from "./agenda-body";
import { meetingRequest, meetingUrl } from "./api";
import { CreateMeetingDialog } from "./create-meeting-dialog";
import {
    type AgendaSummaryState,
    RecordingAgendaContext,
} from "./recording-agenda-context";
import type { AgendaCandidate, MeetingDetail, NextMeeting } from "./types";

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
        notice: ReactNode;
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
    const [dismissed, setDismissed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [prepareOpen, setPrepareOpen] = useState(false);
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
            if (signal?.aborted) return;
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
    const summaryWasWorking = useRef(false);
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
            await meetingRequest(meetingUrl(chosen, "/attach"), "POST", {
                recordingItemId: recording.id,
            });
            await load(undefined, true);
            onChanged();
        } catch {
            setCandidates(previous);
            toast.error(i18n("Could not attach the agenda"));
        } finally {
            setBusy(false);
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
            onChanged();
            await load(undefined, false);
        } catch {
            setAttached(previous);
            toast.error(i18n("Could not detach the agenda"));
        } finally {
            setBusy(false);
        }
    }
    const notice = attached
        ? own && (
              <div className="flex items-start justify-between gap-3 rounded-lg border border-meeting/30 bg-meeting/5 p-3 text-sm">
                  <div>
                      <p className="font-medium">{i18n("Agenda attached")}</p>
                      <p className="text-xs text-muted-foreground">
                          {attached.title}
                      </p>
                      <p className="mt-1 max-w-xl text-xs text-muted-foreground">
                          {i18n(
                              "Detaching restores the standalone meeting. Existing summaries and actual task changes remain.",
                          )}
                      </p>
                  </div>
                  <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void detach()}
                  >
                      {i18n("Detach")}
                  </Button>
              </div>
          )
        : candidates.length > 0 &&
          !dismissed && (
              <Card>
                  <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                          <CalendarClock className="size-4 text-meeting" />
                          {i18n("Attach an agenda?")}
                      </CardTitle>
                      <p className="text-xs text-muted-foreground">
                          {i18n("The recording overlaps prepared meetings.")}
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
                                          · {candidate.folder.name} ·{" "}
                                          {i18n(
                                              "{minutes, number} min overlap",
                                              {
                                                  minutes: Math.round(
                                                      candidate.overlapMs /
                                                          60000,
                                                  ),
                                              },
                                          )}
                                      </span>
                                      {candidate.widensSharing && (
                                          <span className="mt-1 block text-xs">
                                              {i18n(
                                                  "Shared-folder audience: {names}. Publication follows the recording owner’s review.",
                                                  {
                                                      names: candidate.audience
                                                          .organization
                                                          ? i18n("Organization")
                                                          : candidate.audience.users
                                                                .map(
                                                                    (person) =>
                                                                        person.name ??
                                                                        i18n(
                                                                            "Unknown author",
                                                                        ),
                                                                )
                                                                .join(", "),
                                                  },
                                              )}
                                          </span>
                                      )}
                                  </span>
                              </label>
                          ))}
                      </fieldset>
                      <p className="text-xs text-muted-foreground">
                          {i18n(
                              "The recording will be filed into the agenda’s folder. Organization sharing may wait for the owner’s speaker review.",
                          )}
                      </p>
                      <div className="flex justify-end gap-2">
                          <Button
                              variant="ghost"
                              onClick={() => setDismissed(true)}
                          >
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
    const card = attached && (
        <Card>
            <CardContent>
                {summaryState?.hasSummary && !attached.outcomeSummaryId && (
                    <p className="mb-3 text-xs text-muted-foreground">
                        {i18n(
                            "This summary was made before the agenda was attached.",
                        )}{" "}
                        {summaryState && (
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={summaryState.disabled}
                                onClick={summaryState.run}
                            >
                                {i18n("Re-summarize")}
                            </Button>
                        )}
                    </p>
                )}
                <AgendaBody
                    key={attached.id}
                    id={attached.id}
                    variant="recording"
                    initial={attached}
                    userId={userId}
                    folders={folders}
                />
            </CardContent>
        </Card>
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
                {i18n("Prepare next meeting")}
            </Button>
        </div>
    );
    return (
        <RecordingAgendaContext.Provider value={reportSummary}>
            {children ? (
                children({ notice, agenda: card, nextMeeting })
            ) : (
                <>
                    {notice}
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
