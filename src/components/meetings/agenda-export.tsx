"use client";

import { Calendar, Copy, Download, MoreHorizontal } from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { meetingRequest, meetingUrl } from "./api";
import type { MeetingDetail } from "./types";

export function AgendaExport({
    detail,
    disabled = false,
}: {
    detail: MeetingDetail;
    disabled?: boolean;
}) {
    const i18n = useExtracted();
    const locale = useLocale();
    const [open, setOpen] = useState(false);
    const [includeTasks, setIncludeTasks] = useState(false);
    const [preview, setPreview] = useState<string | null>(null);
    const [previewError, setPreviewError] = useState(false);
    const [busy, setBusy] = useState(false);
    const [written, setWritten] = useState(false);
    const [consent, setConsent] = useState<string | null>(null);
    const endpoint = meetingUrl(
        detail.id,
        `/markdown?locale=${encodeURIComponent(locale)}`,
    );
    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        setPreview(null);
        setPreviewError(false);
        void fetch(
            `${endpoint}&includeTasks=${includeTasks}&version=${detail.version}`,
            {
                signal: controller.signal,
            },
        )
            .then(async (response) => {
                if (!response.ok) throw new Error();
                const value = await response.text();
                if (!controller.signal.aborted) setPreview(value);
            })
            .catch(() => {
                if (!controller.signal.aborted) setPreviewError(true);
            });
        return () => controller.abort();
    }, [open, endpoint, includeTasks, detail.version]);
    async function copy() {
        try {
            const response = await fetch(endpoint);
            if (!response.ok) throw new Error();
            const markdown = await response.text();
            if (navigator.clipboard) {
                await navigator.clipboard.writeText(markdown);
            } else {
                const focused = document.activeElement;
                const field = document.createElement("textarea");
                field.value = markdown;
                field.style.position = "fixed";
                field.style.opacity = "0";
                field.setAttribute("aria-hidden", "true");
                document.body.append(field);
                try {
                    field.select();
                    if (!document.execCommand("copy")) throw new Error();
                } finally {
                    field.remove();
                    if (focused instanceof HTMLElement && focused.isConnected)
                        focused.focus({ preventScroll: true });
                }
            }
            toast.success(i18n("Agenda Markdown copied"));
        } catch {
            toast.error(i18n("Could not copy the agenda"));
        }
    }
    async function write() {
        setBusy(true);
        try {
            const result = await meetingRequest<{
                needsConsent: boolean;
                connectUrl?: string;
            }>(meetingUrl(detail.id, "/calendar-export"), "POST", {
                includeTasks,
                locale,
            });
            if (result.needsConsent && result.connectUrl) {
                setConsent(result.connectUrl);
            } else {
                setWritten(true);
                setOpen(false);
                toast.success(
                    i18n(
                        "Agenda written to the event. Invitees received no email.",
                    ),
                );
            }
        } catch (err) {
            toast.error(
                err instanceof Error
                    ? err.message
                    : i18n("Could not export the agenda"),
            );
        } finally {
            setBusy(false);
        }
    }
    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={i18n("Agenda export")}
                        disabled={disabled}
                    >
                        <MoreHorizontal className="size-4" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    align="end"
                    className="max-w-[min(24rem,90vw)]"
                >
                    <DropdownMenuItem
                        disabled={disabled}
                        onSelect={() => void copy()}
                    >
                        <Copy />
                        {i18n("Copy agenda Markdown")}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={disabled} asChild>
                        <a href={endpoint}>
                            <Download />
                            {i18n("Download agenda Markdown")}
                        </a>
                    </DropdownMenuItem>
                    {detail.calendarEventId && (
                        <>
                            <DropdownMenuItem
                                disabled={
                                    disabled ||
                                    detail.canExportCalendar === false
                                }
                                onSelect={() => setOpen(true)}
                            >
                                <Calendar />
                                {written
                                    ? i18n(
                                          "Write to the Google Calendar event again…",
                                      )
                                    : i18n(
                                          "Write to the Google Calendar event…",
                                      )}
                            </DropdownMenuItem>
                            {detail.canExportCalendar === false && (
                                <p className="px-2 pb-2 text-xs text-muted-foreground">
                                    {detail.calendar?.organizer?.name
                                        ? i18n(
                                              "Only the event organizer, {name}, can do this. Send them the Markdown.",
                                              {
                                                  name: detail.calendar
                                                      .organizer.name,
                                              },
                                          )
                                        : i18n(
                                              "Only the event organizer can do this. Send them the Markdown.",
                                          )}
                                </p>
                            )}
                            {detail.canExportCalendar === null && (
                                <p className="px-2 pb-2 text-xs text-muted-foreground">
                                    {i18n(
                                        "Organizer access will be checked when you export.",
                                    )}
                                </p>
                            )}
                            {written && (
                                <p className="px-2 pb-2 text-xs text-muted-foreground">
                                    {i18n(
                                        "Agenda is in the event. Later changes need another export.",
                                    )}
                                </p>
                            )}
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            <Dialog
                open={open}
                onOpenChange={(value) => {
                    setOpen(value);
                    if (!value) setConsent(null);
                }}
            >
                <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
                    <DialogHeader>
                        <DialogTitle>
                            {i18n("Write the agenda to the event")}
                        </DialogTitle>
                        <DialogDescription>{detail.title}</DialogDescription>
                    </DialogHeader>
                    <p className="text-sm">
                        {i18n(
                            "Only this occurrence will change, never the recurring series. Invitees receive no email. People using other calendars may not see the change.",
                        )}
                    </p>
                    <p className="rounded-md border p-3 text-sm">
                        {detail.calendar?.externalInviteeCount === null
                            ? i18n(
                                  "All invitees can read the exported agenda. The number outside your organization is unavailable.",
                              )
                            : i18n(
                                  "All {count, number} invitees can see this, including {external, number} outside your organization. Review the agenda before exporting.",
                                  {
                                      count:
                                          detail.calendar?.attendeeCount ?? 0,
                                      external:
                                          detail.calendar
                                              ?.externalInviteeCount ?? 0,
                                  },
                              )}
                    </p>
                    <label className="flex items-start gap-2 text-sm">
                        <input
                            type="checkbox"
                            className="mt-1 accent-primary"
                            checked={includeTasks}
                            onChange={(event) =>
                                setIncludeTasks(event.target.checked)
                            }
                        />
                        <span>
                            {i18n("Include task review")}
                            <span className="block text-xs text-muted-foreground">
                                {i18n(
                                    "Assignee notes are never exported. Off by default.",
                                )}
                            </span>
                        </span>
                    </label>
                    <p className="text-xs text-muted-foreground">
                        {i18n(
                            "Your existing description stays above a marked agenda block. The next export replaces only that block.",
                        )}
                    </p>
                    <section
                        aria-label={i18n("Calendar export preview")}
                        className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-mono text-xs"
                    >
                        {previewError
                            ? i18n("Could not load the preview")
                            : (preview ?? i18n("Loading preview…"))}
                    </section>
                    {consent && (
                        <p className="text-sm">
                            {i18n(
                                "Google will ask once for permission to edit events. After returning, open this dialog and confirm the export. Granting permission does not write the agenda.",
                            )}
                        </p>
                    )}
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setOpen(false)}
                        >
                            {i18n("Cancel")}
                        </Button>
                        {consent ? (
                            <Button asChild>
                                <a href={consent}>
                                    {i18n("Continue to Google")}
                                </a>
                            </Button>
                        ) : (
                            <Button
                                disabled={busy || disabled || !preview}
                                onClick={() => void write()}
                            >
                                {busy
                                    ? i18n("Writing…")
                                    : i18n("Write to event")}
                            </Button>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
