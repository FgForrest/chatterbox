"use client";

import { Check, Copy, Download, Loader2, MoreHorizontal } from "lucide-react";
import { useExtracted } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SidecarKind } from "@/lib/export/document-sidecars";
import { type RecordingView, withRecordingView } from "@/lib/sharing/view";

interface MarkdownActionsProps {
    kind: SidecarKind | "agenda";
    endpoint?: string;
    disabled?: boolean;
    recordingId: string;
    source: string;
    view?: RecordingView;
    /**
     * Collapse copy/download into one menu below 560px. The enclosing card must be a
     * `@container/transcription` (transcript) or `@container/summary` (summary).
     */
    collapseAtNarrowWidth?: boolean;
}

export function MarkdownActions({
    kind,
    recordingId,
    source,
    view,
    collapseAtNarrowWidth = false,
    endpoint: customEndpoint,
    disabled = false,
}: MarkdownActionsProps) {
    const i18n = useExtracted();
    const [copyState, setCopyState] = useState<"idle" | "copying" | "copied">(
        "idle",
    );
    const endpoint =
        customEndpoint ??
        withRecordingView(
            `/api/recordings/${encodeURIComponent(recordingId)}/markdown/${kind}?source=${encodeURIComponent(source)}`,
            view,
        );
    const documentLabel =
        kind === "transcript"
            ? i18n("transcript")
            : kind === "agenda"
              ? i18n("agenda")
              : i18n("summary");

    const narrowContainer = kind === "transcript" ? "transcription" : "summary";
    const actionsLabel =
        kind === "transcript"
            ? i18n("Transcript actions")
            : kind === "agenda"
              ? i18n("Agenda actions")
              : i18n("Summary actions");

    const copyMarkdown = async () => {
        setCopyState("copying");
        try {
            const response = await fetch(endpoint, { cache: "no-store" });
            if (!response.ok) throw new Error("Markdown download failed");
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
            setCopyState("copied");
            toast.success(
                kind === "transcript"
                    ? i18n("Transcript Markdown copied")
                    : kind === "agenda"
                      ? i18n("Agenda Markdown copied")
                      : i18n("Summary Markdown copied"),
            );
            window.setTimeout(() => setCopyState("idle"), 1500);
        } catch {
            setCopyState("idle");
            toast.error(
                i18n("Failed to copy {document} Markdown", {
                    document: documentLabel,
                }),
            );
        }
    };

    return (
        <>
            <div
                className={
                    collapseAtNarrowWidth
                        ? narrowContainer === "transcription"
                            ? "hidden items-center gap-1 @min-[560px]/transcription:flex"
                            : "hidden items-center gap-1 @min-[560px]/summary:flex"
                        : "flex items-center gap-1"
                }
            >
                <Button
                    asChild
                    size="icon-sm"
                    variant="ghost"
                    className={
                        disabled ? "pointer-events-none opacity-50" : undefined
                    }
                >
                    <a
                        aria-disabled={disabled || undefined}
                        tabIndex={disabled ? -1 : undefined}
                        href={disabled ? undefined : endpoint}
                        aria-label={i18n("Download {document} Markdown", {
                            document: documentLabel,
                        })}
                        title={i18n("Download {document} Markdown", {
                            document: documentLabel,
                        })}
                    >
                        <Download className="size-4" />
                    </a>
                </Button>
                <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    onClick={copyMarkdown}
                    disabled={disabled || copyState === "copying"}
                    aria-label={i18n("Copy {document} Markdown", {
                        document: documentLabel,
                    })}
                    title={i18n("Copy {document} Markdown", {
                        document: documentLabel,
                    })}
                >
                    {copyState === "copying" ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : copyState === "copied" ? (
                        <Check className="size-4" />
                    ) : (
                        <Copy className="size-4" />
                    )}
                </Button>
            </div>
            {collapseAtNarrowWidth && (
                <div
                    className={
                        narrowContainer === "transcription"
                            ? "@min-[560px]/transcription:hidden"
                            : "@min-[560px]/summary:hidden"
                    }
                >
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                aria-label={actionsLabel}
                                title={actionsLabel}
                            >
                                <MoreHorizontal className="size-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild disabled={disabled}>
                                <a href={disabled ? undefined : endpoint}>
                                    <Download className="size-4" />
                                    {i18n("Download {document} Markdown", {
                                        document: documentLabel,
                                    })}
                                </a>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onSelect={() => void copyMarkdown()}
                                disabled={disabled || copyState === "copying"}
                            >
                                <Copy className="size-4" />
                                {i18n("Copy {document} Markdown", {
                                    document: documentLabel,
                                })}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            )}
        </>
    );
}
