"use client";

import { CalendarDays, X } from "lucide-react";
import { useExtracted, useFormatter } from "next-intl";
import { cn } from "@/lib/utils";

/** Today in the viewer's time zone, `YYYY-MM-DD`. */
export function localToday(): string {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60_000;
    return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

/**
 * A task's due date: the day, shown in the viewer's format, picked with
 * the browser's date input; the deadline as it was said underneath, while
 * it is a proposal's. Red once past, for an open task.
 */
export function DueDateField({
    value,
    phrase,
    overdue,
    disabled,
    onChange,
}: {
    value: string | null;
    phrase?: string | null;
    /** Mark a past date (an open task's). */
    overdue: boolean;
    disabled: boolean;
    onChange: (value: string | null) => void;
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    const late = overdue && value !== null && value < localToday();
    const shown = value
        ? format.dateTime(new Date(`${value}T12:00:00`), {
              weekday: "short",
              day: "numeric",
              month: "short",
          })
        : null;

    return (
        <span className="inline-flex items-center gap-1 text-xs">
            <span
                className={cn(
                    "relative inline-flex items-center gap-1 rounded-md border px-2 py-1",
                    disabled
                        ? "cursor-default"
                        : "cursor-pointer hover:bg-muted",
                    late && "border-destructive/60 text-destructive",
                    !value && "text-muted-foreground",
                )}
                title={
                    phrase ? i18n("Said: “{phrase}”", { phrase }) : undefined
                }
            >
                <CalendarDays className="size-3 shrink-0" />
                <span>
                    {shown ?? (phrase ? `“${phrase}”` : i18n("No date"))}
                </span>
                {!disabled && (
                    <input
                        type="date"
                        value={value ?? ""}
                        onChange={(event) =>
                            onChange(event.target.value || null)
                        }
                        onClick={(event) => event.currentTarget.showPicker?.()}
                        aria-label={i18n("Due date")}
                        className="absolute inset-0 cursor-pointer opacity-0"
                    />
                )}
            </span>
            {value && !disabled && (
                <button
                    type="button"
                    onClick={() => onChange(null)}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={i18n("Clear the due date")}
                >
                    <X className="size-3" />
                </button>
            )}
            {value && phrase && !disabled && (
                <span className="text-muted-foreground">“{phrase}”</span>
            )}
        </span>
    );
}
