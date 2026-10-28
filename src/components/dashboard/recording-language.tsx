"use client";

import { Languages, Pencil } from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { ActionTooltip } from "@/components/ui/tooltip";
import { getApiErrorMessage } from "@/lib/api-errors";
import {
    normalizeDetectedLanguage,
    recordingLanguageName,
    SELECTABLE_RECORDING_LANGUAGES,
} from "@/lib/recordings/language";
import { type RecordingView, withRecordingView } from "@/lib/sharing/view";

interface LanguageMetadata {
    confirmedLanguage: string | null;
    needsResummary: boolean;
    needsTitleRegeneration: boolean;
    canChange?: boolean;
}

/** The recording's confirmed language and explicitly requested follow-up actions. */
export function RecordingLanguage({
    recordingId,
    detectedLanguage,
    readOnly,
    view,
    refreshKey,
    onReload,
    onResummarize,
    resummarizeDisabled,
    transcriptionDisabled,
    source,
    onTranscribe,
}: {
    recordingId: string;
    detectedLanguage?: string;
    readOnly: boolean;
    view?: RecordingView;
    refreshKey: number;
    onReload: () => void;
    onResummarize?: () => void;
    resummarizeDisabled: boolean;
    transcriptionDisabled: boolean;
    source?: string;
    onTranscribe: (
        source: string | undefined,
        retranscribe: boolean,
        language: string,
    ) => void;
}) {
    const i18n = useExtracted();
    const locale = useLocale();
    const [editing, setEditing] = useState(false);
    const [metadata, setMetadata] = useState<LanguageMetadata | null>(null);
    const [saving, setSaving] = useState(false);
    const [regeneratingTitle, setRegeneratingTitle] = useState(false);
    const [titleRefreshKey, setTitleRefreshKey] = useState(0);
    const url = withRecordingView(
        `/api/recordings/${recordingId}/language`,
        view,
    );
    useEffect(() => {
        void refreshKey;
        void resummarizeDisabled;
        void titleRefreshKey;
        const controller = new AbortController();
        void fetch(url, { signal: controller.signal })
            .then(async (response) => {
                if (response.ok)
                    setMetadata((await response.json()) as LanguageMetadata);
            })
            .catch(() => {});
        return () => controller.abort();
    }, [url, refreshKey, resummarizeDisabled, titleRefreshKey]);
    const name = (code: string) => recordingLanguageName(code, locale);
    const confirmed = metadata?.confirmedLanguage;
    const detected = normalizeDetectedLanguage(detectedLanguage);
    const shown = confirmed ?? detectedLanguage;
    const canChange = !readOnly && metadata?.canChange === true;

    const change = async (language: string | null) => {
        if ((metadata?.confirmedLanguage ?? null) === language) return;
        const previous = metadata;
        setMetadata((value) => ({
            confirmedLanguage: language,
            needsResummary: value?.needsResummary ?? false,
            needsTitleRegeneration: value?.needsTitleRegeneration ?? false,
            canChange: true,
        }));
        setSaving(true);
        try {
            const response = await fetch(url, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ language }),
            });
            if (!response.ok)
                throw new Error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not change the recording language"),
                    ),
                );
            setMetadata({
                ...((await response.json()) as LanguageMetadata),
                canChange: true,
            });
            onReload();
        } catch (error) {
            setMetadata(previous);
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Could not change the recording language"),
            );
        } finally {
            setSaving(false);
        }
    };
    const regenerateTitle = async () => {
        setRegeneratingTitle(true);
        try {
            const response = await fetch(
                withRecordingView(`/api/recordings/${recordingId}/title`, view),
                { method: "POST" },
            );
            if (!response.ok)
                throw new Error(
                    await getApiErrorMessage(
                        response,
                        i18n("Failed to regenerate title"),
                    ),
                );
            setTitleRefreshKey((value) => value + 1);
            onReload();
            toast.success(i18n("Title regenerated"));
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Failed to regenerate title"),
            );
        } finally {
            setRegeneratingTitle(false);
        }
    };
    return (
        <div className="flex flex-wrap items-center gap-2">
            <Languages className="size-3" />
            {canChange && editing ? (
                <Select
                    open
                    onOpenChange={(next) => {
                        if (!next) setEditing(false);
                    }}
                    value={confirmed ?? "auto"}
                    onValueChange={(value) => {
                        setEditing(false);
                        void change(value === "auto" ? null : value);
                    }}
                >
                    <SelectTrigger
                        className="h-7 w-auto text-xs"
                        aria-label={i18n("Transcript language")}
                    >
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="auto">
                            {i18n("Automatic")}
                        </SelectItem>
                        {SELECTABLE_RECORDING_LANGUAGES.map((option) => (
                            <SelectItem key={option.code} value={option.code}>
                                {name(option.code)}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            ) : (
                <>
                    <span>
                        {confirmed
                            ? name(confirmed)
                            : i18n("{language} (detected)", {
                                  language: shown
                                      ? name(shown)
                                      : i18n("Unknown"),
                              })}
                    </span>
                    {canChange && (
                        <ActionTooltip
                            label={i18n("Change transcript language")}
                        >
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="size-6"
                                disabled={saving}
                                aria-label={i18n("Change transcript language")}
                                onClick={() => setEditing(true)}
                            >
                                <Pencil className="size-3" />
                            </Button>
                        </ActionTooltip>
                    )}
                </>
            )}
            {canChange && confirmed && (
                <>
                    {metadata?.needsResummary && (
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={
                                saving || resummarizeDisabled || !onResummarize
                            }
                            onClick={onResummarize}
                        >
                            {i18n("Re-summarize")}
                        </Button>
                    )}
                    {metadata?.needsTitleRegeneration && (
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={saving || regeneratingTitle}
                            onClick={() => void regenerateTitle()}
                        >
                            {i18n("Regenerate title")}
                        </Button>
                    )}
                    {detected && detected !== confirmed && (
                        <AlertDialog>
                            <AlertDialogTrigger asChild>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={saving || transcriptionDisabled}
                                >
                                    {i18n("Re-transcribe in {language}", {
                                        language: name(confirmed),
                                    })}
                                </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                                <AlertDialogHeader>
                                    <AlertDialogTitle>
                                        {i18n("Re-transcribe this recording?")}
                                    </AlertDialogTitle>
                                    <AlertDialogDescription>
                                        {i18n(
                                            "This replaces the transcript, then regenerates the summary, title, and topics, and runs Learn again. It also makes a paid call to your transcription provider.",
                                        )}
                                    </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                    <AlertDialogCancel>
                                        {i18n("Cancel")}
                                    </AlertDialogCancel>
                                    <AlertDialogAction
                                        onClick={() =>
                                            onTranscribe(
                                                source,
                                                true,
                                                confirmed,
                                            )
                                        }
                                    >
                                        {i18n("Re-transcribe")}
                                    </AlertDialogAction>
                                </AlertDialogFooter>
                            </AlertDialogContent>
                        </AlertDialog>
                    )}
                </>
            )}
        </div>
    );
}
