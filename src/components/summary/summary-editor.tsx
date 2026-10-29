"use client";

import { useExtracted } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useAutoGrow } from "@/hooks/use-auto-grow";

/** Edit summary prose and key points inside either item's shared summary card. */
export function SummaryEditor({
    summary,
    keyPoints,
    onSave,
    onCancel,
}: {
    summary: string;
    keyPoints: string[];
    onSave: (
        summary: string,
        keyPoints: string[],
    ) => Promise<boolean | "conflict">;
    onCancel: () => void;
}) {
    const i18n = useExtracted();
    const id = useId();
    const [text, setText] = useState(summary);
    const [points, setPoints] = useState(keyPoints.join("\n"));
    const [saving, setSaving] = useState(false);
    const textRef = useAutoGrow(text);
    const pointsRef = useAutoGrow(points);
    return (
        <form
            className="space-y-4"
            onSubmit={async (event) => {
                event.preventDefault();
                setSaving(true);
                const saved = await onSave(
                    text,
                    points
                        .split(/\r?\n/)
                        .map((point) => point.trim())
                        .filter(Boolean),
                );
                setSaving(false);
                if (saved === true) {
                    toast.success(i18n("Summary saved"));
                    onCancel();
                } else if (saved === "conflict") {
                    toast.error(
                        i18n(
                            "The summary changed. Your draft is kept. Reload before trying again.",
                        ),
                    );
                } else
                    toast.error(
                        i18n(
                            "Could not save the summary. Reload and try again.",
                        ),
                    );
            }}
        >
            <div className="space-y-5 rounded-lg bg-muted p-4">
                <div className="space-y-2">
                    <Label htmlFor={`${id}-text`}>
                        {i18n("Summary text")}{" "}
                        <span className="text-muted-foreground">
                            {i18n("Markdown")}
                        </span>
                    </Label>
                    <textarea
                        ref={textRef}
                        id={`${id}-text`}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 min-h-64 max-h-[70vh] resize-none overflow-y-auto text-sm leading-6"
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        disabled={saving}
                        maxLength={200_000}
                    />
                    <p className="text-xs text-muted-foreground">
                        {i18n(
                            "Speakers are links: [Name](#speaker-N). Keep the link so the name follows later speaker renames.",
                        )}
                    </p>
                </div>
                <div className="space-y-2">
                    <Label htmlFor={`${id}-points`}>
                        {i18n("Key Points")}{" "}
                        <span className="text-muted-foreground">
                            {i18n("one per line")}
                        </span>
                    </Label>
                    <textarea
                        ref={pointsRef}
                        id={`${id}-points`}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 min-h-36 max-h-[50vh] resize-none overflow-y-auto text-sm leading-6"
                        value={points}
                        onChange={(event) => setPoints(event.target.value)}
                        disabled={saving}
                    />
                </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-md text-xs text-muted-foreground">
                    {i18n(
                        "The saved summary is marked as hand-edited. Automatic processing will keep your edits.",
                    )}
                </p>
                <div className="flex gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        disabled={saving}
                        onClick={onCancel}
                    >
                        {i18n("Cancel")}
                    </Button>
                    <Button type="submit" disabled={saving || !text.trim()}>
                        {saving ? i18n("Saving…") : i18n("Save")}
                    </Button>
                </div>
            </div>
            <p className="border-t pt-3 text-xs text-muted-foreground">
                {i18n("Edit tasks in the task list below the summary.")}
            </p>
        </form>
    );
}
