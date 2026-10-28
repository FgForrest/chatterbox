"use client";

import { Loader2, MessageSquareText, Sparkles, Trash2 } from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import { useEffect, useId, useState } from "react";
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
import { Label } from "@/components/ui/label";
import { ActionTooltip } from "@/components/ui/tooltip";
import { type RecordingView, withRecordingView } from "@/lib/sharing/view";
import type { SummaryRemark } from "@/lib/summary/edits";
import type { SummaryRemarksPreview } from "@/lib/summary/remarks-preview";

interface RemarksData {
    remarks: SummaryRemark[];
    preview: SummaryRemarksPreview;
}

/** Store item corrections and start a single summary revision through the existing queue. */
export function SummaryRemarksDialog({
    itemId,
    profileId,
    view,
    onClose,
    onRun,
}: {
    itemId: string;
    profileId: string;
    view?: RecordingView;
    onClose: () => void;
    onRun: () => void;
}) {
    const i18n = useExtracted();
    const locale = useLocale();
    const id = useId();
    const [data, setData] = useState<RemarksData | null>(null);
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const url = `/api/recordings/${itemId}/summary/remarks`;
    useEffect(() => {
        const controller = new AbortController();
        fetch(
            withRecordingView(
                `${url}?profileId=${encodeURIComponent(profileId)}`,
                view,
            ),
            {
                signal: controller.signal,
            },
        )
            .then(async (response) => {
                if (!response.ok) throw new Error("remarks unavailable");
                return response.json() as Promise<RemarksData>;
            })
            .then(setData)
            .catch(() => {
                if (!controller.signal.aborted) setFailed(true);
            });
        return () => controller.abort();
    }, [url, profileId, view]);
    const remove = async (remarkId: string) => {
        if (!data) return;
        const previous = data;
        setData({
            ...data,
            remarks: data.remarks.filter((remark) => remark.id !== remarkId),
        });
        setBusy(true);
        try {
            const response = await fetch(
                withRecordingView(
                    `${url}?remarkId=${encodeURIComponent(remarkId)}`,
                    view,
                ),
                { method: "DELETE" },
            );
            if (!response.ok) throw new Error("remark deletion failed");
        } catch {
            setData(previous);
            toast.error(i18n("Could not delete the remark"));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog
            open
            onOpenChange={(open) => {
                if (!open && !busy) onClose();
            }}
        >
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <MessageSquareText className="size-5" />
                        {i18n("Summary remarks")}
                    </DialogTitle>
                    <DialogDescription>
                        {i18n(
                            "Describe what the summary got wrong. The model reads the source, current summary and all remarks to correct it. Stored remarks also apply to every later summary run by you, including automatic runs.",
                        )}
                    </DialogDescription>
                </DialogHeader>
                {!data ? (
                    <output className="text-sm text-muted-foreground">
                        {failed
                            ? i18n(
                                  "Could not load the remarks and model. Close and try again.",
                              )
                            : i18n("Loading…")}
                    </output>
                ) : (
                    <>
                        <section
                            className="space-y-3"
                            aria-label={i18n("Stored remarks")}
                        >
                            <h3 className="text-sm font-medium">
                                {i18n("Stored remarks ({count})", {
                                    count: String(data.remarks.length),
                                })}
                            </h3>
                            <ul className="space-y-2">
                                {data.remarks.map((remark) => (
                                    <li
                                        key={remark.id}
                                        className="flex items-start gap-3 rounded-lg border bg-muted p-3"
                                    >
                                        <span
                                            aria-hidden
                                            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
                                        >
                                            {(remark.authorName ?? "")
                                                .split(/\s+/)
                                                .map((part) => part[0])
                                                .slice(0, 2)
                                                .join("")}
                                        </span>
                                        <div className="min-w-0 flex-1 space-y-1">
                                            <p className="text-xs text-muted-foreground">
                                                <span className="font-medium text-foreground">
                                                    {remark.authorName ??
                                                        i18n("Unknown author")}
                                                </span>{" "}
                                                ·{" "}
                                                <time
                                                    dateTime={remark.createdAt}
                                                >
                                                    {new Date(
                                                        remark.createdAt,
                                                    ).toLocaleString(locale)}
                                                </time>
                                            </p>
                                            <p className="whitespace-pre-wrap break-words text-sm">
                                                {remark.text}
                                            </p>
                                        </div>
                                        <ActionTooltip
                                            label={i18n("Delete remark")}
                                        >
                                            <Button
                                                type="button"
                                                size="icon-sm"
                                                variant="ghost"
                                                aria-label={i18n(
                                                    "Delete remark",
                                                )}
                                                disabled={busy}
                                                onClick={() =>
                                                    void remove(remark.id)
                                                }
                                            >
                                                <Trash2 className="size-4" />
                                            </Button>
                                        </ActionTooltip>
                                    </li>
                                ))}
                            </ul>
                            <p className="text-xs text-muted-foreground">
                                {i18n(
                                    "Deleting a remark affects future summaries. It does not change this summary.",
                                )}
                            </p>
                        </section>
                        <div className="space-y-2">
                            <Label htmlFor={id}>{i18n("New remark")}</Label>
                            <textarea
                                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                id={id}
                                rows={4}
                                maxLength={20_000}
                                value={text}
                                onChange={(event) =>
                                    setText(event.target.value)
                                }
                                disabled={busy}
                            />
                            {data.preview.available ? (
                                <p className="text-xs text-muted-foreground">
                                    {i18n("Profile")} {data.preview.profileName}{" "}
                                    · {data.preview.provider} ·{" "}
                                    <span className="font-mono">
                                        {data.preview.model}
                                    </span>
                                </p>
                            ) : (
                                <output className="block text-xs text-muted-foreground">
                                    {data.preview.reason ===
                                    "profile-unavailable"
                                        ? i18n(
                                              "Choose an available profile to correct this summary.",
                                          )
                                        : i18n(
                                              "Configure a summary provider and model to correct this summary.",
                                          )}
                                </output>
                            )}
                        </div>
                    </>
                )}
                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={onClose}
                    >
                        {i18n("Cancel")}
                    </Button>
                    <Button
                        type="button"
                        disabled={
                            busy ||
                            !data ||
                            !data.preview.available ||
                            (!text.trim() && !data.remarks.length)
                        }
                        onClick={async () => {
                            setBusy(true);
                            try {
                                if (text.trim()) {
                                    const response = await fetch(
                                        withRecordingView(url, view),
                                        {
                                            method: "POST",
                                            headers: {
                                                "Content-Type":
                                                    "application/json",
                                            },
                                            body: JSON.stringify({ text }),
                                        },
                                    );
                                    if (!response.ok)
                                        throw new Error("remark save failed");
                                    const saved =
                                        (await response.json()) as Pick<
                                            RemarksData,
                                            "remarks"
                                        >;
                                    setData((previous) =>
                                        previous
                                            ? {
                                                  ...previous,
                                                  remarks: saved.remarks,
                                              }
                                            : previous,
                                    );
                                    setText("");
                                }
                                onRun();
                                onClose();
                            } catch {
                                toast.error(i18n("Could not save the remark"));
                            } finally {
                                setBusy(false);
                            }
                        }}
                    >
                        {busy ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Sparkles className="size-4" />
                        )}
                        {i18n("Correct summary")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
