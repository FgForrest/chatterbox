"use client";

import { CalendarDays, X } from "lucide-react";
import { useExtracted, useFormatter } from "next-intl";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Today in the viewer's time zone, `YYYY-MM-DD`. */
export function localToday(): string {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60_000;
    return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

/**
 * A task's text, edited in place: saved on blur or Enter, put back on
 * Escape or when left empty or unchanged.
 */
export function TaskTextInput({
    text,
    className,
    onSave,
}: {
    text: string;
    className?: string;
    onSave: (text: string) => void;
}) {
    const i18n = useExtracted();
    const [draft, setDraft] = useState(text);
    const input = useRef<HTMLTextAreaElement>(null);
    useEffect(() => setDraft(text), [text]);
    useLayoutEffect(() => {
        if (!input.current) return;
        input.current.rows = draft.split("\n").length;
        input.current.style.height = "auto";
        input.current.style.height = `${input.current.scrollHeight}px`;
    }, [draft]);

    const save = () => {
        const next = draft.trim();
        if (!next || next === text) {
            setDraft(text);
            return;
        }
        onSave(next);
    };

    return (
        <textarea
            ref={input}
            rows={1}
            maxLength={2000}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={save}
            onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.blur();
                }
                if (event.key === "Escape") {
                    setDraft(text);
                    event.currentTarget.blur();
                }
            }}
            aria-label={i18n("Task")}
            className={cn(
                "min-h-6 resize-none overflow-hidden whitespace-pre-wrap rounded border border-transparent bg-transparent px-1 hover:border-border focus:border-ring focus:outline-none",
                className,
            )}
        />
    );
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
