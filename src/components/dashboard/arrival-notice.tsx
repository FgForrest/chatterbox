"use client";

import { Mail, Mic, UserPlus, X } from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format-date";
import { formatDurationMs } from "@/lib/format-duration";
import { cn } from "@/lib/utils";
import type { DateTimeFormat } from "@/types/common";
import type { Recording } from "@/types/recording";

/** A dashboard arrival with the same metadata and selection action as its row. */
export function ArrivalNotice({
    recording,
    more,
    dateTimeFormat,
    onOpen,
    onClose,
    invitation = false,
    folderInvitation = false,
}: {
    recording: Recording;
    more: number;
    dateTimeFormat: DateTimeFormat;
    onOpen: () => void;
    onClose: () => void;
    invitation?: boolean;
    folderInvitation?: boolean;
}) {
    const i18n = useExtracted();
    const locale = useLocale();
    const mail = recording.kind === "mail";
    const Icon = invitation ? UserPlus : mail ? Mail : Mic;
    const title = recording.filename || (mail ? i18n("(no subject)") : "");
    return (
        <div className="grid w-full grid-cols-[34px_minmax(0,1fr)] items-start gap-3 rounded-lg border bg-popover p-3 pl-3.5 text-popover-foreground shadow-lg">
            <span
                className={cn(
                    "grid size-[34px] place-items-center rounded-lg",
                    invitation
                        ? "bg-person-share/10 text-person-share"
                        : "bg-primary/10 text-primary",
                )}
            >
                <Icon className="size-[18px]" aria-hidden="true" />
            </span>
            <div className="min-w-0">
                <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-baseline gap-2 text-xs">
                        <strong
                            className={cn(
                                "font-semibold",
                                invitation
                                    ? "text-person-share"
                                    : "text-primary",
                            )}
                        >
                            {invitation
                                ? folderInvitation
                                    ? i18n("{owner} shared a folder with you", {
                                          owner:
                                              recording.ownerName ??
                                              i18n("A colleague"),
                                      })
                                    : i18n("{owner} shared an item with you", {
                                          owner:
                                              recording.ownerName ??
                                              i18n("A colleague"),
                                      })
                                : mail
                                  ? i18n("New email")
                                  : i18n("New recording")}
                        </strong>
                        {more > 0 && (
                            <span className="text-muted-foreground">
                                {i18n("+{count} more", { count: String(more) })}
                            </span>
                        )}
                    </div>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        className="-mr-1 -mt-1 size-6 shrink-0 text-muted-foreground"
                        aria-label={i18n("Close notice")}
                        onClick={onClose}
                    >
                        <X className="size-3.5" aria-hidden="true" />
                    </Button>
                </div>
                <div className="truncate text-sm font-semibold" title={title}>
                    {title}
                </div>
                <div className="mt-1 flex min-w-0 items-center justify-between gap-2.5">
                    <div className="truncate text-xs text-muted-foreground tabular-nums">
                        {folderInvitation
                            ? i18n("Read-only shared folder")
                            : mail
                              ? (recording.mail?.from ?? i18n("Unknown sender"))
                              : formatDurationMs(recording.duration)}
                        {" · "}
                        {formatDateTime(
                            recording.startTime,
                            dateTimeFormat,
                            locale,
                        )}
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 px-3 text-xs"
                        aria-label={i18n('Open "{title}"', { title })}
                        onClick={onOpen}
                    >
                        {i18n("Open")}
                    </Button>
                </div>
            </div>
        </div>
    );
}
