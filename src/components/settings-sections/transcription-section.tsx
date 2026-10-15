"use client";

import { FileText, GraduationCap, ListTree } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ProfilesSettingsLink } from "@/components/settings/profiles-settings-link";
import { ProviderRoleSelect } from "@/components/settings/provider-role-select";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useSettings } from "@/hooks/use-settings";

export function TranscriptionSection({
    mode = "transcription",
}: {
    mode?: "transcription" | "topics" | "learning";
}) {
    const i18n = useExtracted();
    const { isLoadingSettings, isSavingSettings, setIsLoadingSettings } =
        useSettings();
    const languageOptions = useMemo(
        () => [
            { label: i18n("Auto-detect"), value: null },
            { label: i18n("English"), value: "en" },
            { label: i18n("Spanish"), value: "es" },
            { label: i18n("French"), value: "fr" },
            { label: i18n("German"), value: "de" },
            { label: i18n("Italian"), value: "it" },
            { label: i18n("Portuguese"), value: "pt" },
            { label: i18n("Dutch"), value: "nl" },
            { label: i18n("Swedish"), value: "sv" },
            { label: i18n("Danish"), value: "da" },
            { label: i18n("Norwegian"), value: "no" },
            { label: i18n("Finnish"), value: "fi" },
            { label: i18n("Polish"), value: "pl" },
            { label: i18n("Czech"), value: "cs" },
            { label: i18n("Ukrainian"), value: "uk" },
            { label: i18n("Russian"), value: "ru" },
            { label: i18n("Romanian"), value: "ro" },
            { label: i18n("Hungarian"), value: "hu" },
            { label: i18n("Greek"), value: "el" },
            { label: i18n("Turkish"), value: "tr" },
            { label: i18n("Arabic"), value: "ar" },
            { label: i18n("Hebrew"), value: "he" },
            { label: i18n("Hindi"), value: "hi" },
            { label: i18n("Indonesian"), value: "id" },
            { label: i18n("Vietnamese"), value: "vi" },
            { label: i18n("Thai"), value: "th" },
            { label: i18n("Chinese"), value: "zh" },
            { label: i18n("Japanese"), value: "ja" },
            { label: i18n("Korean"), value: "ko" },
        ],
        [i18n],
    );
    const [defaultTranscriptionLanguage, setDefaultTranscriptionLanguage] =
        useState<string | null>(null);
    const [importPlaudContent, setImportPlaudContent] = useState(false);
    const [syncTitleToPlaud, setSyncTitleToPlaud] = useState(false);
    const [preferredTranscriptSource, setPreferredTranscriptSource] =
        useState("plaud");
    const [autoLearnOffered, setAutoLearnOffered] = useState(false);

    useEffect(() => {
        const controller = new AbortController();
        const load = async () => {
            try {
                const response = await fetch("/api/settings/user", {
                    signal: controller.signal,
                });
                if (!response.ok) return;
                const data = (await response.json()) as Record<string, unknown>;
                setDefaultTranscriptionLanguage(
                    typeof data.defaultTranscriptionLanguage === "string"
                        ? data.defaultTranscriptionLanguage
                        : null,
                );
                setImportPlaudContent(data.importPlaudContent === true);
                setSyncTitleToPlaud(data.syncTitleToPlaud === true);
                setPreferredTranscriptSource(
                    data.preferredTranscriptSource === "riffado"
                        ? "riffado"
                        : "plaud",
                );
                setAutoLearnOffered(data.autoLearnOffered === true);
            } catch (error) {
                if (
                    !(
                        error instanceof DOMException &&
                        error.name === "AbortError"
                    )
                ) {
                    console.error("Failed to fetch settings:", error);
                }
            } finally {
                if (!controller.signal.aborted) setIsLoadingSettings(false);
            }
        };
        void load();
        return () => controller.abort();
    }, [setIsLoadingSettings]);

    const save = async (
        patch: Record<string, unknown>,
        rollback: () => void,
    ) => {
        try {
            const response = await fetch("/api/settings/user", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(patch),
            });
            if (!response.ok) throw new Error("Failed to save settings");
        } catch {
            rollback();
            toast.error(i18n("Failed to save settings. Changes reverted."));
        }
    };

    if (isLoadingSettings) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
        );
    }

    if (mode === "learning") {
        return (
            <div className="space-y-6">
                <SettingsSectionHeader
                    title={i18n("Learning")}
                    description={i18n("Learn from corrected transcripts.")}
                    icon={GraduationCap}
                />
                {autoLearnOffered ? (
                    <ProviderRoleSelect purpose="learning" />
                ) : (
                    <p className="text-sm text-muted-foreground">
                        {i18n("Learning is not available on this instance.")}
                    </p>
                )}
                <ProfilesSettingsLink />
            </div>
        );
    }

    if (mode === "topics") {
        return (
            <div className="space-y-6">
                <SettingsSectionHeader
                    title={i18n("Topics")}
                    description={i18n(
                        "Choose the default provider for topic detection.",
                    )}
                    icon={ListTree}
                />
                <ProviderRoleSelect purpose="topics" />
                <ProfilesSettingsLink />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <SettingsSectionHeader
                title={i18n("Transcription")}
                description={i18n(
                    "Account defaults for transcribing now and displaying imported transcripts.",
                )}
                icon={FileText}
            />
            <ProviderRoleSelect purpose="transcription" />
            <ProviderRoleSelect purpose="title" />
            <ProfilesSettingsLink />
            <div className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                    <div className="space-y-0.5">
                        <Label
                            htmlFor="import-plaud-content"
                            className="text-base"
                        >
                            {i18n("Import Plaud transcripts and summaries")}
                        </Label>
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "Import content Plaud has already produced when recordings sync.",
                            )}
                        </p>
                    </div>
                    <Switch
                        id="import-plaud-content"
                        checked={importPlaudContent}
                        disabled={isSavingSettings}
                        onCheckedChange={(checked) => {
                            const previous = importPlaudContent;
                            setImportPlaudContent(checked);
                            void save({ importPlaudContent: checked }, () =>
                                setImportPlaudContent(previous),
                            );
                        }}
                    />
                </div>

                <div className="flex items-center justify-between gap-4">
                    <div className="space-y-0.5">
                        <Label htmlFor="sync-title-plaud" className="text-base">
                            {i18n("Sync titles to Plaud")}
                        </Label>
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "Update the filename in your Plaud device when titles are generated",
                            )}
                        </p>
                    </div>
                    <Switch
                        id="sync-title-plaud"
                        checked={syncTitleToPlaud}
                        disabled={isSavingSettings}
                        onCheckedChange={(checked) => {
                            const previous = syncTitleToPlaud;
                            setSyncTitleToPlaud(checked);
                            void save({ syncTitleToPlaud: checked }, () =>
                                setSyncTitleToPlaud(previous),
                            );
                        }}
                    />
                </div>

                {importPlaudContent && (
                    <div className="space-y-2">
                        <Label htmlFor="preferred-transcript-source">
                            {i18n("Primary transcript")}
                        </Label>
                        <Select
                            value={preferredTranscriptSource}
                            disabled={isSavingSettings}
                            onValueChange={(value) => {
                                const previous = preferredTranscriptSource;
                                setPreferredTranscriptSource(value);
                                void save(
                                    { preferredTranscriptSource: value },
                                    () =>
                                        setPreferredTranscriptSource(previous),
                                );
                            }}
                        >
                            <SelectTrigger id="preferred-transcript-source">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="plaud">
                                    {i18n("Plaud")}
                                </SelectItem>
                                <SelectItem value="riffado">
                                    {i18n("My provider")}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                            {i18n(
                                "Shown by default when both transcripts exist.",
                            )}
                        </p>
                    </div>
                )}

                <div className="space-y-2">
                    <Label htmlFor="transcription-language">
                        {i18n("Default transcription language")}
                    </Label>
                    <Select
                        value={defaultTranscriptionLanguage ?? "auto"}
                        disabled={isSavingSettings}
                        onValueChange={(value) => {
                            const previous = defaultTranscriptionLanguage;
                            const next = value === "auto" ? null : value;
                            setDefaultTranscriptionLanguage(next);
                            void save(
                                { defaultTranscriptionLanguage: next },
                                () => setDefaultTranscriptionLanguage(previous),
                            );
                        }}
                    >
                        <SelectTrigger id="transcription-language">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {languageOptions.map((option) => (
                                <SelectItem
                                    key={option.value ?? "auto"}
                                    value={option.value ?? "auto"}
                                >
                                    {option.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                        {i18n(
                            "Language used when you transcribe now. Auto-detect identifies it from the recording.",
                        )}
                    </p>
                </div>
            </div>
        </div>
    );
}
