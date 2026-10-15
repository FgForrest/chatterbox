"use client";

import { ListChecks, Pencil } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ProfileEditor } from "@/components/settings/profile-editor";
import { ProfilesSettingsLink } from "@/components/settings/profiles-settings-link";
import { ProviderRoleSelect } from "@/components/settings/provider-role-select";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { LegacyTemplateList } from "@/components/settings/template-list";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useSummaryPresetCopy } from "@/hooks/use-preset-copy";
import { useSettings } from "@/hooks/use-settings";
import {
    isPresetId,
    type PromptTemplate,
    type TemplateConfiguration,
    templatePrompt,
} from "@/lib/ai/prompt-templates";
import {
    normalizeSummaryPromptConfig,
    SUMMARY_TEMPLATE_KIND,
} from "@/lib/ai/summary-presets";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import {
    DEFAULT_MERGE_PROMPT,
    MULTI_PASS_ROUNDS_DEFAULT,
    MULTI_PASS_ROUNDS_MAX,
    MULTI_PASS_ROUNDS_MIN,
} from "@/lib/summary/multi-pass";

const ROUND_OPTIONS = Array.from(
    { length: MULTI_PASS_ROUNDS_MAX - MULTI_PASS_ROUNDS_MIN + 1 },
    (_, index) => MULTI_PASS_ROUNDS_MIN + index,
);

export function SummarySection() {
    const i18n = useExtracted();
    const presetCopy = useSummaryPresetCopy();
    const { isLoadingSettings, isSavingSettings, setIsLoadingSettings } =
        useSettings();
    const [templates, setTemplates] = useState<TemplateConfiguration>(() =>
        normalizeSummaryPromptConfig(null),
    );
    const [copyingId, setCopyingId] = useState<string | null>(null);
    const [editingProfileId, setEditingProfileId] = useState<string | null>(
        null,
    );
    const [multiPass, setMultiPass] = useState(false);
    const [multiPassRounds, setMultiPassRounds] = useState(
        MULTI_PASS_ROUNDS_DEFAULT,
    );
    const [multiPassAuto, setMultiPassAuto] = useState(false);
    const [savedMergePrompt, setSavedMergePrompt] = useState("");
    const [mergePromptDraft, setMergePromptDraft] = useState<string | null>(
        null,
    );
    const multiPassAbortRefs = useRef<Record<string, AbortController | null>>(
        {},
    );

    useEffect(() => {
        const controller = new AbortController();
        const fetchSettings = async () => {
            try {
                const response = await fetch("/api/settings/user", {
                    signal: controller.signal,
                });
                if (!response.ok) return;
                const data = (await response.json()) as Record<string, unknown>;
                setTemplates(normalizeSummaryPromptConfig(data.summaryPrompt));
                setMultiPass(data.summaryMultiPass === true);
                setMultiPassRounds(
                    typeof data.summaryMultiPassRounds === "number"
                        ? data.summaryMultiPassRounds
                        : MULTI_PASS_ROUNDS_DEFAULT,
                );
                setMultiPassAuto(data.summaryMultiPassAuto === true);
                setSavedMergePrompt(
                    typeof data.summaryMergePrompt === "string"
                        ? data.summaryMergePrompt
                        : "",
                );
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
        void fetchSettings();
        return () => controller.abort();
    }, [setIsLoadingSettings]);

    const saveMultiPass = async (
        key: string,
        patch: Record<string, unknown>,
        rollback: () => void,
    ) => {
        multiPassAbortRefs.current[key]?.abort();
        const controller = new AbortController();
        multiPassAbortRefs.current[key] = controller;
        try {
            const response = await fetch("/api/settings/user", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(patch),
                signal: controller.signal,
            });
            if (!response.ok) throw new Error("Failed to save settings");
        } catch {
            if (multiPassAbortRefs.current[key] !== controller) return;
            rollback();
            toast.error(i18n("Failed to save settings. Changes reverted."));
        }
    };

    const copyIntoProfile = async (template: PromptTemplate) => {
        const builtinId = isPresetId(SUMMARY_TEMPLATE_KIND, template.id)
            ? template.id
            : null;
        const name =
            template.name ??
            (builtinId ? presetCopy[builtinId].name : template.id);
        const settings = defaultProfileSettings("audio");
        const uneditedBuiltin =
            builtinId !== null &&
            template.name === null &&
            template.prompt === null;
        settings.steps.summary.preset = builtinId ?? "general";
        settings.steps.summary.fullPrompt = uneditedBuiltin
            ? null
            : templatePrompt(template, SUMMARY_TEMPLATE_KIND);
        setCopyingId(template.id);
        try {
            const response = await fetch("/api/settings/profiles", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name,
                    channel: "audio",
                    scope: "personal",
                    settings,
                }),
            });
            const body = (await response.json().catch(() => null)) as {
                profile?: { id?: string };
                error?: string;
            } | null;
            if (!response.ok || !body?.profile?.id) {
                throw new Error(
                    body?.error || i18n("Could not copy the template."),
                );
            }
            setEditingProfileId(body.profile.id);
            toast.success(i18n("Profile “{name}” created", { name }));
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Could not copy the template."),
            );
        } finally {
            setCopyingId(null);
        }
    };

    const saveMergePrompt = () => {
        if (mergePromptDraft === null) return;
        const trimmed = mergePromptDraft.trim();
        const next = trimmed === DEFAULT_MERGE_PROMPT ? "" : trimmed;
        setMergePromptDraft(null);
        if (next === savedMergePrompt) return;
        const previous = savedMergePrompt;
        setSavedMergePrompt(next);
        return saveMultiPass(
            "merge-prompt",
            { summaryMergePrompt: next || null },
            () => setSavedMergePrompt(previous),
        );
    };

    if (isLoadingSettings) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <SettingsSectionHeader
                title={i18n("Summary")}
                description={i18n(
                    "Your default provider and multi-pass preference for summaries.",
                )}
                icon={ListChecks}
            />
            <ProviderRoleSelect purpose="summary" />
            <ProfilesSettingsLink />

            <LegacyTemplateList
                kind={SUMMARY_TEMPLATE_KIND}
                presetCopy={presetCopy}
                config={templates}
                heading={i18n("Templates from before profiles")}
                copyingId={copyingId}
                onCopy={(template) => void copyIntoProfile(template)}
            />

            <div className="space-y-4 border-t pt-4">
                <div className="flex items-center justify-between gap-4">
                    <div className="space-y-0.5">
                        <Label htmlFor="multi-pass" className="text-base">
                            {i18n("Multi-pass summarization")}
                        </Label>
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "This preference applies when a profile does not pin the Summary provider.",
                            )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {i18n(
                                "Summarizes the transcript several times in parallel and merges the results. Independent passes can retain different details.",
                            )}
                        </p>
                    </div>
                    <Switch
                        id="multi-pass"
                        checked={multiPass}
                        disabled={isSavingSettings}
                        onCheckedChange={(checked) => {
                            const previous = multiPass;
                            setMultiPass(checked);
                            void saveMultiPass(
                                "enabled",
                                { summaryMultiPass: checked },
                                () => setMultiPass(previous),
                            );
                        }}
                    />
                </div>
                {multiPass && (
                    <>
                        <div className="space-y-2">
                            <Label htmlFor="multi-pass-rounds">
                                {i18n("Passes per summary")}
                            </Label>
                            <Select
                                value={String(multiPassRounds)}
                                disabled={isSavingSettings}
                                onValueChange={(value) => {
                                    const previous = multiPassRounds;
                                    const next = Number(value);
                                    setMultiPassRounds(next);
                                    void saveMultiPass(
                                        "rounds",
                                        { summaryMultiPassRounds: next },
                                        () => setMultiPassRounds(previous),
                                    );
                                }}
                            >
                                <SelectTrigger id="multi-pass-rounds">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {ROUND_OPTIONS.map((count) => (
                                        <SelectItem
                                            key={count}
                                            value={String(count)}
                                        >
                                            {count} {i18n("passes")}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex items-center justify-between gap-4">
                            <Label
                                htmlFor="multi-pass-auto"
                                className="text-base"
                            >
                                {i18n("Also use for automatic runs")}
                            </Label>
                            <Switch
                                id="multi-pass-auto"
                                checked={multiPassAuto}
                                disabled={isSavingSettings}
                                onCheckedChange={(checked) => {
                                    const previous = multiPassAuto;
                                    setMultiPassAuto(checked);
                                    void saveMultiPass(
                                        "auto",
                                        { summaryMultiPassAuto: checked },
                                        () => setMultiPassAuto(previous),
                                    );
                                }}
                            />
                        </div>
                        <div className="flex items-center justify-between gap-4">
                            <div>
                                <p className="text-base font-medium">
                                    {i18n("Merge prompt")}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                    {savedMergePrompt
                                        ? i18n(
                                              "Using your custom merge prompt.",
                                          )
                                        : i18n(
                                              "Using the built-in merge prompt.",
                                          )}
                                </p>
                            </div>
                            <Button
                                type="button"
                                size="sm"
                                disabled={isSavingSettings}
                                onClick={() =>
                                    setMergePromptDraft(
                                        savedMergePrompt ||
                                            DEFAULT_MERGE_PROMPT,
                                    )
                                }
                            >
                                <Pencil className="mr-2 size-4" />
                                {i18n("Change merge prompt")}
                            </Button>
                        </div>
                    </>
                )}
            </div>

            {mergePromptDraft !== null && (
                <Dialog
                    open
                    onOpenChange={(open) => !open && setMergePromptDraft(null)}
                >
                    <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-3xl">
                        <DialogTitle>{i18n("Merge prompt")}</DialogTitle>
                        <DialogDescription>
                            {i18n(
                                "Combines the passes into one summary while preserving their distinct details.",
                            )}
                        </DialogDescription>
                        <textarea
                            aria-label={i18n("Merge prompt")}
                            className="min-h-[360px] w-full resize-y rounded-md border px-3 py-2 font-mono text-sm"
                            value={mergePromptDraft}
                            onChange={(event) =>
                                setMergePromptDraft(event.target.value)
                            }
                        />
                        <div className="flex justify-between gap-2">
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={() =>
                                    setMergePromptDraft(DEFAULT_MERGE_PROMPT)
                                }
                            >
                                {i18n("Restore built-in prompt")}
                            </Button>
                            <div className="flex gap-2">
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => setMergePromptDraft(null)}
                                >
                                    {i18n("Cancel")}
                                </Button>
                                <Button type="button" onClick={saveMergePrompt}>
                                    {i18n("Save")}
                                </Button>
                            </div>
                        </div>
                    </DialogContent>
                </Dialog>
            )}

            {editingProfileId && (
                <ProfileEditor
                    profileId={editingProfileId}
                    open
                    onOpenChange={(open) => {
                        if (!open) setEditingProfileId(null);
                    }}
                    onSaved={() => undefined}
                />
            )}
        </div>
    );
}
