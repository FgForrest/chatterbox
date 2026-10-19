"use client";

import { Loader2, Pencil, RefreshCw } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-errors";
import {
    MAX_RECORDING_TITLE_LENGTH,
    normalizeRecordingTitle,
} from "@/lib/recordings/filename";
import { type RecordingView, withRecordingView } from "@/lib/sharing/view";
import { cn } from "@/lib/utils";

export function RecordingTitle({
    recordingId,
    filename,
    onRenamed,
    className,
    readOnly = false,
    view,
    kind = "audio",
}: {
    recordingId: string;
    filename: string;
    onRenamed?: (filename: string) => void;
    className?: string;
    /** Someone else's recording: shown, never renamed. */
    readOnly?: boolean;
    /** The view it is renamed in: the curator renames on the Organization's. */
    view?: RecordingView;
    kind?: "audio" | "mail";
}) {
    const i18n = useExtracted();
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(filename);
    const [saving, setSaving] = useState(false);
    const [regenerating, setRegenerating] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!editing) setDraft(filename);
    }, [filename, editing]);

    useEffect(() => {
        if (!editing) return;
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.select();
    }, [editing]);

    const commit = async () => {
        const next = normalizeRecordingTitle(draft);
        if (!next) {
            toast.error(i18n("Name cannot be empty"));
            setDraft(filename);
            setEditing(false);
            return;
        }
        if (next.length > MAX_RECORDING_TITLE_LENGTH) {
            toast.error(
                i18n(
                    "Name must be {count, plural, one {# character} other {# characters}} or fewer",
                    { count: MAX_RECORDING_TITLE_LENGTH },
                ),
            );
            return;
        }
        if (next === filename) {
            setDraft(filename);
            setEditing(false);
            return;
        }

        setSaving(true);
        try {
            const response = await fetch(
                withRecordingView(`/api/recordings/${recordingId}`, view),
                {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ filename: next }),
                },
            );
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Failed to rename"),
                    ),
                );
                return;
            }
            const body = (await response.json()) as { filename?: string };
            const saved = body.filename ?? next;
            setEditing(false);
            setDraft(saved);
            onRenamed?.(saved);
        } catch {
            toast.error(i18n("Failed to rename"));
        } finally {
            setSaving(false);
        }
    };

    const regenerate = async () => {
        setRegenerating(true);
        try {
            const response = await fetch(
                withRecordingView(`/api/recordings/${recordingId}/title`, view),
                {
                    method: "POST",
                },
            );
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Failed to regenerate title"),
                    ),
                );
                return;
            }
            const body = (await response.json()) as { filename: string };
            onRenamed?.(body.filename);
            toast.success(i18n("Title regenerated"));
        } catch {
            toast.error(i18n("Failed to regenerate title"));
        } finally {
            setRegenerating(false);
        }
    };

    if (readOnly) {
        return (
            <span className={cn("block truncate", className)}>{filename}</span>
        );
    }

    if (editing) {
        return (
            <input
                ref={inputRef}
                value={draft}
                disabled={saving}
                maxLength={MAX_RECORDING_TITLE_LENGTH}
                aria-label={
                    kind === "mail"
                        ? i18n("Mail title")
                        : i18n("Recording name")
                }
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                    if (!saving) void commit();
                }}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        if (e.nativeEvent.isComposing) return;
                        e.preventDefault();
                        void commit();
                    } else if (e.key === "Escape") {
                        e.preventDefault();
                        setDraft(filename);
                        setEditing(false);
                    }
                }}
                className={cn(
                    "w-full min-w-0 rounded-md bg-transparent px-1 -mx-1 font-semibold outline-none",
                    "focus-visible:ring-ring/50 focus-visible:ring-[3px]",
                    "disabled:opacity-60",
                    className,
                )}
            />
        );
    }

    return (
        <span className="group/title inline-flex max-w-full min-w-0 items-center gap-1">
            <button
                type="button"
                onClick={() => setEditing(true)}
                title={i18n("Rename")}
                aria-label={i18n("Rename {name}", { name: filename })}
                className={cn(
                    "inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md text-left",
                    "hover:bg-accent/60 focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
                    "px-1 -mx-1 py-0.5",
                )}
            >
                <span className={cn("truncate", className)}>{filename}</span>
                <Pencil
                    className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-within/title:opacity-100 [@media(hover:none)]:opacity-100"
                    aria-hidden="true"
                />
            </button>
            <button
                type="button"
                onClick={() => void regenerate()}
                disabled={regenerating}
                title={i18n("Regenerate title")}
                aria-label={i18n("Regenerate title for {name}", {
                    name: filename,
                })}
                className={cn(
                    "shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-within/title:opacity-100 [@media(hover:none)]:opacity-100",
                    "hover:bg-accent/60 hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
                    regenerating && "opacity-100",
                )}
            >
                {regenerating ? (
                    <Loader2 className="size-4 animate-spin" />
                ) : (
                    <RefreshCw className="size-4" />
                )}
            </button>
        </span>
    );
}
