"use client";

import { Settings2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTimeZone } from "use-intl/react";
import { useConfirm } from "@/components/confirm-dialog";
import { useProductName } from "@/components/product-name-provider";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { dateTimeInput, dateTimeInputIso } from "@/lib/i18n/time-zone";
import type { Recording } from "@/types/recording";
import { AgendaCalendarExport } from "./agenda-export";
import { meetingRequest } from "./api";
import { CalendarEventPicker } from "./calendar-event-picker";
import type { CalendarChoices, MeetingDetail } from "./types";

export function MeetingSettings({
    detail,
    onSave,
    onDelete,
}: {
    detail: MeetingDetail;
    recordings?: Recording[];
    onSave: (
        change: {
            title?: string;
            start?: string | null;
            end?: string | null;
            calendarEventId?: string | null;
            previous: {
                title?: string;
                start?: string | null;
                end?: string | null;
                calendarEventId?: string | null;
            };
        },
        optimistic: Partial<MeetingDetail>,
    ) => Promise<boolean>;
    onDelete: () => Promise<boolean>;
}) {
    const i18n = useExtracted();
    const timeZone = useTimeZone() ?? "UTC";
    const localTime = useCallback(
        (value: string | null) => dateTimeInput(value, timeZone),
        [timeZone],
    );
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState(detail.title);
    const [start, setStart] = useState(localTime(detail.plannedStart));
    const [end, setEnd] = useState(localTime(detail.plannedEnd));
    const [eventId, setEventId] = useState(detail.calendarEventId ?? "");
    const [events, setEvents] = useState<CalendarChoices | null>(null);
    const [busy, setBusy] = useState(false);
    const confirm = useConfirm();
    const product = useProductName("locative");
    const editable =
        detail.permissions.manage &&
        !detail.attachedRecording &&
        !detail.recordingItemId;
    const latest = useRef(detail);
    latest.current = detail;
    const original = useRef(detail);
    const edited = useRef(new Set<string>());
    const [notice, setNotice] = useState(false);
    useEffect(() => {
        if (!open) return;
        const detail = latest.current;
        original.current = detail;
        edited.current.clear();
        setNotice(false);
        setEvents(null);
        setTitle(detail.title);
        setStart(localTime(detail.plannedStart));
        setEnd(localTime(detail.plannedEnd));
        setEventId(detail.calendarEventId ?? "");
        const controller = new AbortController();
        void meetingRequest<CalendarChoices>(
            `/api/meetings/calendar-events?agendaId=${encodeURIComponent(detail.id)}`,
            "GET",
            undefined,
            controller.signal,
        )
            .then((result) => {
                if (!controller.signal.aborted) setEvents(result);
            })
            .catch(() => {});
        return () => controller.abort();
    }, [open, localTime]);
    return (
        <>
            <Button
                variant="ghost"
                size="icon-sm"
                aria-label={i18n("Agenda settings")}
                onClick={() => setOpen(true)}
            >
                <Settings2 className="size-4" />
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{i18n("Agenda settings")}</DialogTitle>
                        <DialogDescription>
                            {i18n(
                                "Edit the title, time or linked calendar event.",
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <label className="grid gap-1 text-sm">
                        {i18n("Title")}
                        <input
                            disabled={busy || !editable}
                            value={title}
                            maxLength={500}
                            className="rounded border bg-background p-2"
                            onChange={(event) => {
                                edited.current.add("title");
                                setTitle(event.target.value);
                            }}
                        />
                    </label>
                    <label className="grid gap-1 text-sm">
                        {i18n("Start (optional)")}
                        <input
                            disabled={busy || !editable}
                            type="datetime-local"
                            value={start}
                            className="rounded border bg-background p-2"
                            onChange={(event) => {
                                edited.current.add("start");
                                setStart(event.target.value);
                            }}
                        />
                    </label>
                    <label className="grid gap-1 text-sm">
                        {i18n("End (optional)")}
                        <input
                            disabled={busy || !editable}
                            type="datetime-local"
                            value={end}
                            min={start || undefined}
                            className="rounded border bg-background p-2"
                            onChange={(event) => {
                                edited.current.add("end");
                                setEnd(event.target.value);
                            }}
                        />
                    </label>
                    {(detail.calendarEventId || (events && !events.reason)) && (
                        <div className="grid gap-2 text-sm">
                            {i18n("Calendar event")}
                            <CalendarEventPicker
                                choices={events}
                                value={eventId}
                                current={
                                    detail.calendarEventId
                                        ? {
                                              id: detail.calendarEventId,
                                              title: detail.title,
                                          }
                                        : undefined
                                }
                                agendaId={detail.id}
                                allowEmpty
                                disabled={busy || !editable}
                                onValueChange={(value) => {
                                    edited.current.add("calendarEventId");
                                    setEventId(value);
                                }}
                            />
                            <AgendaCalendarExport
                                detail={detail}
                                disabled={
                                    busy ||
                                    eventId !== (detail.calendarEventId ?? "")
                                }
                            />
                        </div>
                    )}
                    {notice && (
                        <p role="alert">
                            {i18n(
                                "Your changes were not saved. Your input is kept. Review the current agenda and try again.",
                            )}
                        </p>
                    )}
                    <DialogFooter>
                        {editable && (
                            <Button
                                variant="destructive"
                                disabled={busy}
                                onClick={() => {
                                    void confirm({
                                        title: i18n("Delete agenda"),
                                        description: (
                                            <div className="space-y-2">
                                                <p>
                                                    {i18n(
                                                        "Delete this agenda in {product}? Its points and notes are deleted.",
                                                        { product },
                                                    )}
                                                </p>
                                                {detail.calendarEventId && (
                                                    <p>
                                                        {i18n(
                                                            "The Google Calendar event stays as it is, including an agenda exported into it.",
                                                        )}
                                                    </p>
                                                )}
                                                <p>
                                                    {i18n(
                                                        "Tasks closed or dropped during the meeting stay that way.",
                                                    )}
                                                </p>
                                            </div>
                                        ),
                                        confirmLabel: i18n("Delete agenda"),
                                        pendingLabel: i18n("Deleting…"),
                                        destructive: true,
                                        onConfirm: async () => {
                                            setBusy(true);
                                            try {
                                                if (!(await onDelete())) {
                                                    setNotice(true);
                                                    throw new Error(
                                                        i18n(
                                                            "Could not delete the agenda",
                                                        ),
                                                    );
                                                }
                                                setOpen(false);
                                            } finally {
                                                setBusy(false);
                                            }
                                        },
                                    });
                                }}
                            >
                                {i18n("Delete agenda")}
                            </Button>
                        )}
                        <Button
                            variant="outline"
                            onClick={() => setOpen(false)}
                        >
                            {i18n("Cancel")}
                        </Button>
                        <Button
                            disabled={
                                busy ||
                                !editable ||
                                !title.trim() ||
                                Boolean(end && (!start || end <= start)) ||
                                Boolean(
                                    start && !dateTimeInputIso(start, timeZone),
                                ) ||
                                Boolean(end && !dateTimeInputIso(end, timeZone))
                            }
                            onClick={() => {
                                const plannedStart = start
                                    ? dateTimeInputIso(start, timeZone)
                                    : null;
                                const plannedEnd = end
                                    ? dateTimeInputIso(end, timeZone)
                                    : null;
                                const before = notice
                                    ? latest.current
                                    : original.current;
                                const change = {
                                    ...(edited.current.has("title") &&
                                    title.trim() !== before.title
                                        ? { title: title.trim() }
                                        : {}),
                                    ...(edited.current.has("start") &&
                                    start !== localTime(before.plannedStart)
                                        ? { start: plannedStart }
                                        : {}),
                                    ...(edited.current.has("end") &&
                                    end !== localTime(before.plannedEnd)
                                        ? { end: plannedEnd }
                                        : {}),
                                    ...(edited.current.has("calendarEventId") &&
                                    eventId !== (before.calendarEventId ?? "")
                                        ? { calendarEventId: eventId || null }
                                        : {}),
                                };
                                const previous = {
                                    ...("title" in change
                                        ? { title: before.title }
                                        : {}),
                                    ...("start" in change
                                        ? { start: before.plannedStart }
                                        : {}),
                                    ...("end" in change
                                        ? { end: before.plannedEnd }
                                        : {}),
                                    ...("calendarEventId" in change
                                        ? {
                                              calendarEventId:
                                                  before.calendarEventId,
                                          }
                                        : {}),
                                };
                                if (!Object.keys(change).length) {
                                    setOpen(false);
                                    return;
                                }
                                setBusy(true);
                                void onSave(
                                    { ...change, previous },
                                    {
                                        ...("title" in change
                                            ? { title: title.trim() }
                                            : {}),
                                        ...("start" in change
                                            ? {
                                                  plannedStart,
                                                  timeSet: Boolean(start),
                                              }
                                            : {}),
                                        ...("end" in change
                                            ? { plannedEnd }
                                            : {}),
                                        ...("calendarEventId" in change
                                            ? {
                                                  calendarEventId:
                                                      eventId || null,
                                              }
                                            : {}),
                                    },
                                )
                                    .then((saved) => {
                                        if (saved) setOpen(false);
                                        else {
                                            setNotice(true);
                                        }
                                    })
                                    .finally(() => setBusy(false));
                            }}
                        >
                            {i18n("Save")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
