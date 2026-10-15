"use client";

import { useExtracted, useLocale } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { ProviderListItem } from "@/lib/ai/list-providers";
import { MAIL_SUMMARY_PROMPT_PARTS } from "@/lib/ai/mail-summary-prompts";
import { TITLE_PROMPTS_BY_LOCALE } from "@/lib/ai/prompt-presets";
import {
    isEnhancementOnlyProvider,
    isTranscriptionOnlyProvider,
} from "@/lib/ai/provider-presets";
import {
    AI_OUTPUT_LANGUAGES,
    SUMMARY_PROMPT_PARTS,
    type SummaryPreset,
} from "@/lib/ai/summary-presets";
import {
    defaultProfileSettings,
    type ProfileChannel,
    type ProfileScope,
    type ProfileSettings,
    type ProviderPin,
} from "@/lib/profiles/settings";
import {
    MULTI_PASS_ROUNDS_MAX,
    MULTI_PASS_ROUNDS_MIN,
} from "@/lib/summary/multi-pass";
import { TOPIC_PROMPTS_BY_LOCALE } from "@/lib/topics/topic-presets";
import type { PromptPreset } from "@/types/ai";
import type {
    SettingsProfileBuiltins,
    SettingsProfileDetail,
} from "@/types/settings";

type EditorMode = "basic" | "advanced";
type PromptLocale = "en" | "cs-CZ";
type CommonStepName = "transcribe" | "learn" | "title" | "topics" | "summary";

interface CommonStep {
    enabled: boolean;
    automatic: boolean;
    provider: ProviderPin | null;
}

interface OrganizationProvider {
    id: string;
    provider: string;
    defaultModel: string | null;
    disabledAt: string | null;
}

interface ProviderOption {
    id: string;
    scope: "personal" | "organization";
    label: string;
    transcriptionOnly: boolean;
    enhancementOnly: boolean;
    available: boolean;
}

interface ProfileEditorProps {
    profileId: string | null;
    newChannel?: ProfileChannel;
    newScope?: ProfileScope;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved: () => void;
}

const PROMPT_LOCALES: PromptLocale[] = ["en", "cs-CZ"];
const TITLE_PRESETS: PromptPreset[] = [
    "default",
    "meetings",
    "lectures",
    "phone-calls",
    "audio-blog",
    "idea-stormer",
];
const SUMMARY_PRESETS: SummaryPreset[] = [
    "general",
    "meeting-notes",
    "key-points",
    "action-items",
];
const DEFAULT_PROVIDER_VALUE = "default";
const MIXED_PROVIDER_VALUE = "mixed";

function getCommonStep(
    settings: ProfileSettings,
    name: CommonStepName,
): CommonStep | null {
    if (name === "transcribe") {
        return "transcribe" in settings.steps
            ? settings.steps.transcribe
            : null;
    }
    if (name === "topics") {
        return "topics" in settings.steps ? settings.steps.topics : null;
    }
    return settings.steps[name];
}

function providerValue(pin: ProviderPin | null): string {
    return pin ? `${pin.scope}:${pin.credentialId}` : DEFAULT_PROVIDER_VALUE;
}

function parseProviderValue(value: string): ProviderPin | null {
    if (value === DEFAULT_PROVIDER_VALUE) return null;
    const separator = value.indexOf(":");
    if (separator < 1) return null;
    const scope = value.slice(0, separator);
    if (scope !== "personal" && scope !== "organization") return null;
    return {
        scope,
        credentialId: value.slice(separator + 1),
    };
}

function languageName(locale: string, code: string): string {
    const names = new Intl.DisplayNames([locale], { type: "language" });
    return names.of(code) ?? code;
}

function useStepLabels(): Record<CommonStepName | "tasks", string> {
    const i18n = useExtracted();
    return {
        transcribe: i18n("Transcribe"),
        learn: i18n("Learn"),
        title: i18n("Title"),
        topics: i18n("Topics"),
        summary: i18n("Summary"),
        tasks: i18n("Tasks"),
    };
}

function useTitlePresetLabels(): Record<PromptPreset, string> {
    const i18n = useExtracted();
    return {
        default: i18n("Default title"),
        meetings: i18n("Meetings"),
        lectures: i18n("Lectures"),
        "phone-calls": i18n("Phone calls"),
        "audio-blog": i18n("Audio blog"),
        "idea-stormer": i18n("Idea stormer"),
    };
}

function useSummaryPresetLabels(): Record<SummaryPreset | "mail", string> {
    const i18n = useExtracted();
    return {
        general: i18n("General summary"),
        "meeting-notes": i18n("Meeting notes"),
        "key-points": i18n("Key points"),
        "action-items": i18n("Action items"),
        mail: i18n("Mail summary"),
    };
}

function ProviderPinSelect({
    id,
    value,
    options,
    purpose,
    defaultLabel,
    mixed = false,
    disabled,
    onChange,
}: {
    id: string;
    value: ProviderPin | null;
    options: ProviderOption[];
    purpose: "transcription" | "text";
    defaultLabel: string;
    mixed?: boolean;
    disabled?: boolean;
    onChange: (pin: ProviderPin | null) => void;
}) {
    const i18n = useExtracted();
    const filtered = options.filter(
        (option) =>
            option.available &&
            (purpose === "transcription"
                ? !option.enhancementOnly
                : !option.transcriptionOnly),
    );
    const selectedValue = providerValue(value);
    const unavailable =
        value !== null &&
        !filtered.some(
            (option) =>
                option.id === value.credentialId &&
                option.scope === value.scope,
        );
    return (
        <div className="space-y-2">
            <select
                id={id}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={mixed ? MIXED_PROVIDER_VALUE : selectedValue}
                disabled={disabled}
                onChange={(event) =>
                    onChange(parseProviderValue(event.target.value))
                }
            >
                {mixed && (
                    <option value={MIXED_PROVIDER_VALUE} disabled>
                        {i18n("Different providers per step")}
                    </option>
                )}
                {unavailable && (
                    <option value={selectedValue}>
                        {i18n("Unavailable provider (choose another)")}
                    </option>
                )}
                <option value={DEFAULT_PROVIDER_VALUE}>{defaultLabel}</option>
                {filtered.map((option) => (
                    <option
                        key={`${option.scope}:${option.id}`}
                        value={`${option.scope}:${option.id}`}
                    >
                        {option.label}
                    </option>
                ))}
            </select>
            {unavailable && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                    {i18n(
                        "This pinned provider is disabled or no longer exists. Choose another provider before saving.",
                    )}
                </p>
            )}
        </div>
    );
}

function LocaleTextEditor({
    kind,
    values,
    builtins,
    disabled,
    onChange,
}: {
    kind: "output-format" | "title-prompt" | "topics-prompt";
    values: Partial<Record<PromptLocale, string>>;
    builtins: Record<PromptLocale, string>;
    disabled?: boolean;
    onChange: (values: Partial<Record<PromptLocale, string>>) => void;
}) {
    const i18n = useExtracted();
    const [activeLocale, setActiveLocale] = useState<PromptLocale>("en");
    const customized = values[activeLocale] !== undefined;
    const label =
        kind === "output-format" ? i18n("Output format") : i18n("Prompt");
    const localeLabel = (locale: PromptLocale) =>
        locale === "en" ? i18n("English") : i18n("Czech");

    return (
        <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor={`${kind}-${activeLocale}`}>{label}</Label>
                <span className="text-xs text-muted-foreground">
                    {customized ? i18n("Customized") : i18n("Default")}
                </span>
            </div>
            <div className="flex gap-1" role="tablist" aria-label={label}>
                {PROMPT_LOCALES.map((locale) => (
                    <Button
                        key={locale}
                        type="button"
                        size="sm"
                        variant={
                            activeLocale === locale ? "secondary" : "ghost"
                        }
                        aria-label={
                            kind === "output-format"
                                ? i18n("{language} output format", {
                                      language: localeLabel(locale),
                                  })
                                : i18n("{language} prompt", {
                                      language: localeLabel(locale),
                                  })
                        }
                        aria-selected={activeLocale === locale}
                        role="tab"
                        onClick={() => setActiveLocale(locale)}
                    >
                        {localeLabel(locale)}
                        <span className="ml-1 text-[10px] text-muted-foreground">
                            {values[locale] === undefined
                                ? i18n("Default")
                                : i18n("Customized")}
                        </span>
                    </Button>
                ))}
            </div>
            <textarea
                id={`${kind}-${activeLocale}`}
                aria-label={label}
                className="min-h-28 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm"
                value={values[activeLocale] ?? builtins[activeLocale]}
                disabled={disabled}
                onChange={(event) =>
                    onChange({ ...values, [activeLocale]: event.target.value })
                }
            />
            <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={i18n("Restore default {field}", {
                    field: label,
                })}
                disabled={disabled || !customized}
                onClick={() => {
                    const next = { ...values };
                    delete next[activeLocale];
                    onChange(next);
                }}
            >
                {i18n("Restore default")}
            </Button>
        </div>
    );
}

function CommonStepControls({
    name,
    settings,
    options,
    readOnly,
    updateSettings,
}: {
    name: CommonStepName;
    settings: ProfileSettings;
    options: ProviderOption[];
    readOnly: boolean;
    updateSettings: (change: (next: ProfileSettings) => void) => void;
}) {
    const i18n = useExtracted();
    const stepLabels = useStepLabels();
    const step = getCommonStep(settings, name);
    if (!step) return null;
    const title = stepLabels[name];
    return (
        <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                <Label htmlFor={`${name}-enabled`}>{i18n("Enabled")}</Label>
                <Switch
                    id={`${name}-enabled`}
                    checked={step.enabled}
                    disabled={readOnly}
                    onCheckedChange={(checked) =>
                        updateSettings((next) => {
                            const target = getCommonStep(next, name);
                            if (target) target.enabled = checked;
                        })
                    }
                />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                <Label htmlFor={`${name}-automatic`}>{i18n("Automatic")}</Label>
                <Switch
                    id={`${name}-automatic`}
                    checked={step.automatic}
                    disabled={readOnly || !step.enabled}
                    onCheckedChange={(checked) =>
                        updateSettings((next) => {
                            const target = getCommonStep(next, name);
                            if (target) target.automatic = checked;
                        })
                    }
                />
            </div>
            <div className="space-y-2 sm:col-span-2">
                <Label htmlFor={`${name}-provider`}>
                    {i18n("{step} provider", { step: title })}
                </Label>
                <ProviderPinSelect
                    id={`${name}-provider`}
                    value={step.provider}
                    options={options}
                    purpose={name === "transcribe" ? "transcription" : "text"}
                    defaultLabel={i18n("Default for this role")}
                    disabled={readOnly || !step.enabled}
                    onChange={(provider) =>
                        updateSettings((next) => {
                            const target = getCommonStep(next, name);
                            if (target) target.provider = provider;
                        })
                    }
                />
            </div>
        </div>
    );
}

export function ProfileEditor({
    profileId,
    newChannel,
    newScope,
    open,
    onOpenChange,
    onSaved,
}: ProfileEditorProps) {
    const i18n = useExtracted();
    const locale = useLocale();
    const [profile, setProfile] = useState<SettingsProfileDetail | null>(null);
    const [builtins, setBuiltins] = useState<SettingsProfileBuiltins | null>(
        null,
    );
    const [builtinsPreset, setBuiltinsPreset] = useState<
        SummaryPreset | "mail" | null
    >(null);
    const [mode, setMode] = useState<EditorMode>("basic");
    const [providers, setProviders] = useState<ProviderOption[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [conflictDraft, setConflictDraft] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        let active = true;
        setMode("basic");
        setConflictDraft(null);
        setLoading(true);

        const loadProviders = async () => {
            const [personalResponse, organizationResponse] = await Promise.all([
                fetch("/api/settings/ai/providers"),
                fetch("/api/settings/ai/organization-providers"),
            ]);
            const personal = personalResponse.ok
                ? (
                      (await personalResponse.json()) as {
                          providers: ProviderListItem[];
                      }
                  ).providers
                : [];
            const organization = organizationResponse.ok
                ? (
                      (await organizationResponse.json()) as {
                          providers: OrganizationProvider[];
                      }
                  ).providers
                : [];
            return [
                ...personal.map((provider) => ({
                    id: provider.id,
                    scope: "personal" as const,
                    label: provider.defaultModel
                        ? `${provider.provider} · ${provider.defaultModel}`
                        : provider.provider,
                    transcriptionOnly:
                        provider.managed === true ||
                        isTranscriptionOnlyProvider(provider.provider),
                    enhancementOnly: isEnhancementOnlyProvider(
                        provider.provider,
                    ),
                    available: provider.available !== false,
                })),
                ...organization.map((provider) => ({
                    id: provider.id,
                    scope: "organization" as const,
                    label: provider.defaultModel
                        ? `${i18n("Organization")} · ${provider.provider} · ${provider.defaultModel}`
                        : `${i18n("Organization")} · ${provider.provider}`,
                    transcriptionOnly: isTranscriptionOnlyProvider(
                        provider.provider,
                    ),
                    enhancementOnly: isEnhancementOnlyProvider(
                        provider.provider,
                    ),
                    available: provider.disabledAt === null,
                })),
            ];
        };

        const load = async () => {
            try {
                const loadedProviders = await loadProviders();
                if (!active) return;
                setProviders(loadedProviders);
                if (profileId) {
                    const response = await fetch(
                        `/api/settings/profiles/${encodeURIComponent(profileId)}`,
                    );
                    if (!response.ok) throw new Error("profile");
                    const data = (await response.json()) as {
                        profile: SettingsProfileDetail;
                    } & SettingsProfileBuiltins;
                    if (!active) return;
                    setProfile(data.profile);
                    setBuiltins({
                        builtinPromptsVersion: data.builtinPromptsVersion,
                        builtins: data.builtins,
                    });
                    setBuiltinsPreset(
                        data.profile.settings.steps.summary.preset,
                    );
                } else if (newChannel) {
                    const settings = defaultProfileSettings(newChannel);
                    const defaultPrompts =
                        newChannel === "mail"
                            ? MAIL_SUMMARY_PROMPT_PARTS
                            : SUMMARY_PROMPT_PARTS.general;
                    setProfile({
                        id: "",
                        name:
                            newChannel === "audio"
                                ? i18n("New recordings profile")
                                : i18n("New mail profile"),
                        description: null,
                        channel: newChannel,
                        scope: newScope ?? "personal",
                        isDefault: false,
                        version: 1,
                        canEdit: true,
                        archivedAt: null,
                        updatedAt: "",
                        settings,
                    });
                    setBuiltins({
                        builtinPromptsVersion: "",
                        builtins: {
                            focus: defaultPrompts.focus,
                            outputFormat: defaultPrompts.outputFormat,
                        },
                    });
                    setBuiltinsPreset(settings.steps.summary.preset);
                }
            } catch {
                if (active) {
                    toast.error(i18n("Failed to load profile."));
                    onOpenChange(false);
                }
            } finally {
                if (active) setLoading(false);
            }
        };
        void load();
        return () => {
            active = false;
        };
    }, [i18n, newChannel, newScope, onOpenChange, open, profileId]);

    const availableProviders = useMemo(
        () =>
            profile?.scope === "organization"
                ? providers.filter(
                      (provider) => provider.scope === "organization",
                  )
                : providers,
        [profile?.scope, providers],
    );

    if (!open) return null;

    const updateSettings = (change: (next: ProfileSettings) => void) => {
        setProfile((current) => {
            if (!current) return current;
            const settings = structuredClone(current.settings);
            change(settings);
            return { ...current, settings };
        });
    };

    const reloadLatest = async () => {
        if (!profileId) return;
        const response = await fetch(
            `/api/settings/profiles/${encodeURIComponent(profileId)}`,
        );
        if (!response.ok) return;
        const data = (await response.json()) as {
            profile: SettingsProfileDetail;
        } & SettingsProfileBuiltins;
        setProfile(data.profile);
        setBuiltins({
            builtinPromptsVersion: data.builtinPromptsVersion,
            builtins: data.builtins,
        });
        setBuiltinsPreset(data.profile.settings.steps.summary.preset);
    };

    const copyText = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            toast.success(i18n("Unsaved changes copied."));
        } catch {
            toast.error(i18n("Could not copy the unsaved changes."));
        }
    };

    const save = async () => {
        if (!profile || !profile.name.trim()) return;
        setSaving(true);
        const unsaved = JSON.stringify(
            { name: profile.name, settings: profile.settings },
            null,
            2,
        );
        try {
            const response = await fetch(
                profileId
                    ? `/api/settings/profiles/${encodeURIComponent(profileId)}`
                    : "/api/settings/profiles",
                {
                    method: profileId ? "PUT" : "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(
                        profileId
                            ? {
                                  expectedVersion: profile.version,
                                  name: profile.name.trim(),
                                  description: profile.description,
                                  settings: profile.settings,
                              }
                            : {
                                  name: profile.name.trim(),
                                  description: profile.description,
                                  channel: profile.channel,
                                  scope: profile.scope,
                                  settings: profile.settings,
                              },
                    ),
                },
            );
            if (response.status === 409) {
                setConflictDraft(unsaved);
                toast.error(
                    i18n(
                        "This profile changed elsewhere. The latest version was loaded.",
                    ),
                    {
                        action: {
                            label: i18n("Copy my changes"),
                            onClick: () => void copyText(unsaved),
                        },
                    },
                );
                await reloadLatest();
                return;
            }
            if (!response.ok) {
                const body = (await response.json().catch(() => null)) as {
                    error?: string;
                } | null;
                throw new Error(
                    response.status === 400 && body?.error
                        ? body.error
                        : i18n("Failed to save profile."),
                );
            }
            toast.success(i18n("Profile saved."));
            onSaved();
            onOpenChange(false);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Failed to save profile."),
            );
        } finally {
            setSaving(false);
        }
    };

    const readOnly = profile?.canEdit === false;
    const dialogTitle = profile
        ? i18n("Edit {name}", { name: profile.name })
        : i18n("Profile editor");

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-4xl">
                <DialogTitle>{dialogTitle}</DialogTitle>
                <DialogDescription>
                    {readOnly
                        ? i18n(
                              "This Organization profile is read-only. Duplicate it to make a personal copy.",
                          )
                        : i18n(
                              "Choose the steps, AI providers, and prompts used to process this content.",
                          )}
                </DialogDescription>

                {loading || !profile || !builtins ? (
                    <div className="py-10 text-center text-sm text-muted-foreground">
                        {i18n("Loading profile…")}
                    </div>
                ) : (
                    <div className="space-y-5">
                        {conflictDraft && (
                            <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                                <p className="text-sm font-medium">
                                    {i18n(
                                        "Your unsaved version is kept below so you can copy it.",
                                    )}
                                </p>
                                <textarea
                                    aria-label={i18n("Unsaved profile changes")}
                                    className="max-h-28 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs"
                                    readOnly
                                    value={conflictDraft}
                                />
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => void copyText(conflictDraft)}
                                >
                                    {i18n("Copy my changes")}
                                </Button>
                            </div>
                        )}

                        <div className="space-y-2">
                            <Label htmlFor="profile-name">{i18n("Name")}</Label>
                            <Input
                                id="profile-name"
                                value={profile.name}
                                disabled={readOnly}
                                onChange={(event) =>
                                    setProfile({
                                        ...profile,
                                        name: event.target.value,
                                    })
                                }
                            />
                        </div>

                        <div
                            className="flex gap-2 border-b pb-2"
                            role="tablist"
                        >
                            <Button
                                type="button"
                                variant={
                                    mode === "basic" ? "secondary" : "ghost"
                                }
                                role="tab"
                                aria-selected={mode === "basic"}
                                onClick={() => setMode("basic")}
                            >
                                {i18n("Basic")}
                            </Button>
                            <Button
                                type="button"
                                variant={
                                    mode === "advanced" ? "secondary" : "ghost"
                                }
                                role="tab"
                                aria-selected={mode === "advanced"}
                                onClick={() => setMode("advanced")}
                            >
                                {i18n("Advanced")}
                            </Button>
                        </div>

                        {mode === "basic" ? (
                            <BasicEditor
                                profile={profile}
                                providers={availableProviders}
                                locale={locale}
                                readOnly={readOnly}
                                updateSettings={updateSettings}
                            />
                        ) : (
                            <AdvancedEditor
                                profile={profile}
                                builtins={builtins}
                                builtinsPreset={builtinsPreset}
                                providers={availableProviders}
                                locale={locale}
                                readOnly={readOnly}
                                updateSettings={updateSettings}
                            />
                        )}

                        <div className="flex justify-end gap-2 border-t pt-4">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => onOpenChange(false)}
                            >
                                {readOnly ? i18n("Close") : i18n("Cancel")}
                            </Button>
                            {!readOnly && (
                                <Button
                                    type="button"
                                    onClick={() => void save()}
                                    disabled={saving || !profile.name.trim()}
                                >
                                    {saving
                                        ? i18n("Saving…")
                                        : i18n("Save profile")}
                                </Button>
                            )}
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

function BasicEditor({
    profile,
    providers,
    locale,
    readOnly,
    updateSettings,
}: {
    profile: SettingsProfileDetail;
    providers: ProviderOption[];
    locale: string;
    readOnly: boolean;
    updateSettings: (change: (next: ProfileSettings) => void) => void;
}) {
    const i18n = useExtracted();
    const stepLabels = useStepLabels();
    const settings = profile.settings;
    const textSteps: CommonStepName[] = [
        "learn",
        "title",
        ...(profile.channel === "audio" ? (["topics"] as const) : []),
        "summary",
    ];
    const pins = textSteps.map(
        (name) => getCommonStep(settings, name)?.provider,
    );
    const firstValue = providerValue(pins[0] ?? null);
    const sameProvider = pins.every(
        (pin) => providerValue(pin ?? null) === firstValue,
    );
    const basicProvider = sameProvider ? parseProviderValue(firstValue) : null;
    const summary = settings.steps.summary;
    const fullPromptActive = Boolean(summary.fullPrompt?.trim());
    const automationSteps = [
        ...(profile.channel === "audio" ? (["transcribe"] as const) : []),
        "learn" as const,
        "title" as const,
        ...(profile.channel === "audio" ? (["topics"] as const) : []),
        "summary" as const,
    ];

    return (
        <div className="space-y-5">
            <div className="space-y-2">
                <Label htmlFor="basic-ai">{i18n("AI for text steps")}</Label>
                <ProviderPinSelect
                    id="basic-ai"
                    value={basicProvider}
                    options={providers}
                    purpose="text"
                    defaultLabel={i18n("Default for each role")}
                    mixed={!sameProvider}
                    disabled={readOnly}
                    onChange={(provider) =>
                        updateSettings((next) => {
                            for (const name of textSteps) {
                                const step = getCommonStep(next, name);
                                if (step) step.provider = provider;
                            }
                        })
                    }
                />
                <p className="text-xs text-muted-foreground">
                    {i18n(
                        "Sets the same provider pin for Learn, Title, Topics, and Summary. Default for each role leaves every step unpinned.",
                    )}
                </p>
            </div>

            <div className="space-y-2">
                <Label htmlFor="summary-focus">{i18n("Summary focus")}</Label>
                <Input
                    id="summary-focus"
                    aria-label={i18n("Summary focus")}
                    value={summary.focus ?? ""}
                    placeholder={i18n("What should the summary focus on?")}
                    disabled={readOnly || fullPromptActive}
                    onChange={(event) =>
                        updateSettings((next) => {
                            next.steps.summary.focus =
                                event.target.value || null;
                        })
                    }
                />
                {fullPromptActive && (
                    <p className="text-xs text-muted-foreground">
                        {i18n(
                            "A full prompt replaces the summary focus and output format.",
                        )}
                    </p>
                )}
            </div>

            <div className="space-y-2">
                <Label htmlFor="profile-output-language">
                    {i18n("Output language")}
                </Label>
                <select
                    id="profile-output-language"
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={summary.outputLanguage}
                    disabled={readOnly}
                    onChange={(event) =>
                        updateSettings((next) => {
                            next.steps.summary.outputLanguage =
                                event.target.value;
                        })
                    }
                >
                    {AI_OUTPUT_LANGUAGES.map((language) => (
                        <option key={language.code} value={language.code}>
                            {language.code === "auto"
                                ? i18n("Auto (match content)")
                                : languageName(locale, language.code)}
                        </option>
                    ))}
                </select>
            </div>

            <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <div>
                    <Label htmlFor="profile-tasks">{i18n("Tasks")}</Label>
                    <p className="text-xs text-muted-foreground">
                        {i18n(
                            "When off, this profile creates no tasks and changes no earlier tasks.",
                        )}
                    </p>
                </div>
                <Switch
                    id="profile-tasks"
                    checked={settings.steps.tasks.enabled}
                    disabled={readOnly}
                    onCheckedChange={(checked) =>
                        updateSettings((next) => {
                            next.steps.tasks.enabled = checked;
                        })
                    }
                />
            </div>

            <div className="space-y-2">
                <h3 className="text-sm font-medium">
                    {i18n("Runs automatically")}
                </h3>
                {automationSteps.map((name) => {
                    const step = getCommonStep(settings, name);
                    if (!step) return null;
                    return (
                        <div
                            key={name}
                            className="flex items-center justify-between rounded-md border px-3 py-2"
                        >
                            <Label htmlFor={`basic-${name}-automatic`}>
                                {stepLabels[name]}
                            </Label>
                            {profile.channel === "mail" &&
                                name === "title" &&
                                !step.enabled && (
                                    <p className="mr-auto text-xs text-muted-foreground">
                                        {i18n(
                                            "Titles are off for mail; turn them on in Advanced.",
                                        )}
                                    </p>
                                )}
                            <Switch
                                id={`basic-${name}-automatic`}
                                checked={step.automatic}
                                disabled={readOnly || !step.enabled}
                                onCheckedChange={(checked) =>
                                    updateSettings((next) => {
                                        const target = getCommonStep(
                                            next,
                                            name,
                                        );
                                        if (target) target.automatic = checked;
                                    })
                                }
                            />
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function AdvancedEditor({
    profile,
    builtins,
    builtinsPreset,
    providers,
    locale,
    readOnly,
    updateSettings,
}: {
    profile: SettingsProfileDetail;
    builtins: SettingsProfileBuiltins;
    builtinsPreset: SummaryPreset | "mail" | null;
    providers: ProviderOption[];
    locale: string;
    readOnly: boolean;
    updateSettings: (change: (next: ProfileSettings) => void) => void;
}) {
    const i18n = useExtracted();
    const stepLabels = useStepLabels();
    const settings = profile.settings;
    const steps: (CommonStepName | "tasks")[] = [
        ...(profile.channel === "audio" ? (["transcribe"] as const) : []),
        "learn",
        "title",
        ...(profile.channel === "audio" ? (["topics"] as const) : []),
        "summary",
        "tasks",
    ];

    return (
        <div className="space-y-4">
            {steps.map((name) => (
                <section key={name} className="space-y-4 rounded-lg border p-4">
                    <h3 className="text-base font-semibold">
                        {stepLabels[name]}
                    </h3>
                    {name === "tasks" ? (
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <Label htmlFor="advanced-tasks-enabled">
                                    {i18n("Enabled")}
                                </Label>
                                <p className="text-xs text-muted-foreground">
                                    {i18n(
                                        "Turn off task creation and changes for this profile.",
                                    )}
                                </p>
                            </div>
                            <Switch
                                id="advanced-tasks-enabled"
                                checked={settings.steps.tasks.enabled}
                                disabled={readOnly}
                                onCheckedChange={(checked) =>
                                    updateSettings((next) => {
                                        next.steps.tasks.enabled = checked;
                                    })
                                }
                            />
                        </div>
                    ) : (
                        <CommonStepControls
                            name={name}
                            settings={settings}
                            options={providers}
                            readOnly={readOnly}
                            updateSettings={updateSettings}
                        />
                    )}
                    {name === "transcribe" &&
                        "transcribe" in settings.steps && (
                            <TranscribeSettings
                                settings={settings}
                                readOnly={readOnly}
                                updateSettings={updateSettings}
                            />
                        )}
                    {name === "learn" && (
                        <div className="flex items-center justify-between gap-3">
                            <Label htmlFor="correct-after-learn">
                                {i18n("Correction pass")}
                            </Label>
                            <Switch
                                id="correct-after-learn"
                                checked={settings.steps.learn.correctAfterLearn}
                                disabled={
                                    readOnly || !settings.steps.learn.enabled
                                }
                                onCheckedChange={(checked) =>
                                    updateSettings((next) => {
                                        next.steps.learn.correctAfterLearn =
                                            checked;
                                    })
                                }
                            />
                        </div>
                    )}
                    {name === "title" && (
                        <TitleSettings
                            settings={settings}
                            readOnly={readOnly}
                            updateSettings={updateSettings}
                        />
                    )}
                    {name === "topics" && "topics" in settings.steps && (
                        <LocaleTextEditor
                            kind="topics-prompt"
                            values={settings.steps.topics.prompt}
                            builtins={TOPIC_PROMPTS_BY_LOCALE.default}
                            disabled={
                                readOnly || !settings.steps.topics.enabled
                            }
                            onChange={(prompt) =>
                                updateSettings((next) => {
                                    if ("topics" in next.steps) {
                                        next.steps.topics.prompt = prompt;
                                    }
                                })
                            }
                        />
                    )}
                    {name === "summary" && (
                        <SummarySettings
                            settings={settings}
                            builtins={builtins}
                            builtinsPreset={builtinsPreset}
                            locale={locale}
                            readOnly={readOnly}
                            updateSettings={updateSettings}
                        />
                    )}
                </section>
            ))}
        </div>
    );
}

function TranscribeSettings({
    settings,
    readOnly,
    updateSettings,
}: {
    settings: ProfileSettings;
    readOnly: boolean;
    updateSettings: (change: (next: ProfileSettings) => void) => void;
}) {
    const i18n = useExtracted();
    if (!("transcribe" in settings.steps)) return null;
    const step = settings.steps.transcribe;
    const languageOptions = [
        { label: i18n("Auto-detect"), value: "auto" },
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
    ];
    return (
        <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
                <Label htmlFor="transcribe-language">{i18n("Language")}</Label>
                <select
                    id="transcribe-language"
                    aria-label={i18n("Language")}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={step.language ?? "auto"}
                    disabled={readOnly || !step.enabled}
                    onChange={(event) =>
                        updateSettings((next) => {
                            if ("transcribe" in next.steps) {
                                next.steps.transcribe.language =
                                    event.target.value === "auto"
                                        ? null
                                        : event.target.value;
                            }
                        })
                    }
                >
                    {languageOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
            </div>
            <div className="space-y-2">
                <Label htmlFor="transcribe-quality">{i18n("Quality")}</Label>
                <select
                    id="transcribe-quality"
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={step.quality}
                    disabled={readOnly || !step.enabled}
                    onChange={(event) =>
                        updateSettings((next) => {
                            if ("transcribe" in next.steps) {
                                next.steps.transcribe.quality = event.target
                                    .value as "fast" | "balanced" | "accurate";
                            }
                        })
                    }
                >
                    <option value="fast">{i18n("Fast")}</option>
                    <option value="balanced">{i18n("Balanced")}</option>
                    <option value="accurate">{i18n("Accurate")}</option>
                </select>
            </div>
            <div className="space-y-2">
                <Label htmlFor="plaud-transcript">
                    {i18n("Plaud transcript")}
                </Label>
                <select
                    id="plaud-transcript"
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={step.plaudTranscript}
                    disabled={readOnly || !step.enabled}
                    onChange={(event) =>
                        updateSettings((next) => {
                            if ("transcribe" in next.steps) {
                                next.steps.transcribe.plaudTranscript = event
                                    .target.value as "use" | "also_transcribe";
                            }
                        })
                    }
                >
                    <option value="use">{i18n("Use when available")}</option>
                    <option value="also_transcribe">
                        {i18n("Also transcribe with my provider")}
                    </option>
                </select>
            </div>
        </div>
    );
}

function TitleSettings({
    settings,
    readOnly,
    updateSettings,
}: {
    settings: ProfileSettings;
    readOnly: boolean;
    updateSettings: (change: (next: ProfileSettings) => void) => void;
}) {
    const i18n = useExtracted();
    const presetLabels = useTitlePresetLabels();
    const step = settings.steps.title;
    return (
        <div className="space-y-4">
            <div className="space-y-2">
                <Label htmlFor="title-preset">{i18n("Preset")}</Label>
                <select
                    id="title-preset"
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={step.preset}
                    disabled={readOnly || !step.enabled}
                    onChange={(event) =>
                        updateSettings((next) => {
                            next.steps.title.preset = event.target
                                .value as PromptPreset;
                        })
                    }
                >
                    {TITLE_PRESETS.map((preset) => (
                        <option key={preset} value={preset}>
                            {presetLabels[preset]}
                        </option>
                    ))}
                </select>
            </div>
            <LocaleTextEditor
                kind="title-prompt"
                values={step.prompt}
                builtins={TITLE_PROMPTS_BY_LOCALE[step.preset]}
                disabled={readOnly || !step.enabled}
                onChange={(prompt) =>
                    updateSettings((next) => {
                        next.steps.title.prompt = prompt;
                    })
                }
            />
        </div>
    );
}

function SummarySettings({
    settings,
    builtins,
    builtinsPreset,
    locale,
    readOnly,
    updateSettings,
}: {
    settings: ProfileSettings;
    builtins: SettingsProfileBuiltins;
    builtinsPreset: SummaryPreset | "mail" | null;
    locale: string;
    readOnly: boolean;
    updateSettings: (change: (next: ProfileSettings) => void) => void;
}) {
    const i18n = useExtracted();
    const presetLabels = useSummaryPresetLabels();
    const step = settings.steps.summary;
    const fullPromptActive = Boolean(step.fullPrompt?.trim());
    const promptParts =
        step.preset === builtinsPreset
            ? builtins.builtins
            : step.preset === "mail"
              ? MAIL_SUMMARY_PROMPT_PARTS
              : SUMMARY_PROMPT_PARTS[step.preset];
    const summaryPresets =
        "transcribe" in settings.steps
            ? SUMMARY_PRESETS
            : (["mail", ...SUMMARY_PRESETS] as const);
    return (
        <div className="space-y-4">
            <div className="space-y-2">
                <Label htmlFor="summary-preset">{i18n("Preset")}</Label>
                <select
                    id="summary-preset"
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={step.preset}
                    disabled={readOnly || !step.enabled}
                    onChange={(event) =>
                        updateSettings((next) => {
                            if ("transcribe" in next.steps) {
                                next.steps.summary.preset = event.target
                                    .value as SummaryPreset;
                            } else {
                                next.steps.summary.preset = event.target
                                    .value as SummaryPreset | "mail";
                            }
                        })
                    }
                >
                    {summaryPresets.map((preset) => (
                        <option key={preset} value={preset}>
                            {presetLabels[preset]}
                        </option>
                    ))}
                </select>
            </div>
            <div className="space-y-2">
                <Label htmlFor="advanced-summary-focus">
                    {i18n("Summary focus")}
                </Label>
                <Input
                    id="advanced-summary-focus"
                    aria-label={i18n("Summary focus")}
                    value={step.focus ?? ""}
                    placeholder={
                        promptParts.focus[locale === "cs-CZ" ? "cs-CZ" : "en"]
                    }
                    disabled={readOnly || !step.enabled || fullPromptActive}
                    onChange={(event) =>
                        updateSettings((next) => {
                            next.steps.summary.focus =
                                event.target.value || null;
                        })
                    }
                />
            </div>
            <LocaleTextEditor
                kind="output-format"
                values={step.outputFormat}
                builtins={promptParts.outputFormat}
                disabled={readOnly || !step.enabled || fullPromptActive}
                onChange={(outputFormat) =>
                    updateSettings((next) => {
                        next.steps.summary.outputFormat = outputFormat;
                    })
                }
            />
            {fullPromptActive && (
                <p className="text-xs text-muted-foreground">
                    {i18n(
                        "A full prompt replaces the summary focus and output format.",
                    )}
                </p>
            )}
            <div className="space-y-2">
                <Label htmlFor="full-prompt">{i18n("Full prompt")}</Label>
                <textarea
                    id="full-prompt"
                    aria-label={i18n("Full prompt")}
                    className="min-h-32 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm"
                    value={step.fullPrompt ?? ""}
                    disabled={readOnly || !step.enabled}
                    onChange={(event) =>
                        updateSettings((next) => {
                            next.steps.summary.fullPrompt =
                                event.target.value || null;
                        })
                    }
                />
                <p className="text-xs text-muted-foreground">
                    {i18n(
                        "When set, this replaces the built-in structure, summary focus, and language-specific output format.",
                    )}
                </p>
            </div>
            <div className="space-y-2">
                <Label htmlFor="advanced-output-language">
                    {i18n("Output language")}
                </Label>
                <select
                    id="advanced-output-language"
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={step.outputLanguage}
                    disabled={readOnly || !step.enabled}
                    onChange={(event) =>
                        updateSettings((next) => {
                            next.steps.summary.outputLanguage =
                                event.target.value;
                        })
                    }
                >
                    {AI_OUTPUT_LANGUAGES.map((language) => (
                        <option key={language.code} value={language.code}>
                            {language.code === "auto"
                                ? i18n("Auto (match content)")
                                : languageName(locale, language.code)}
                        </option>
                    ))}
                </select>
            </div>
            <div className="space-y-3 rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                    <div>
                        <Label htmlFor="summary-multi-pass">
                            {i18n("Multi-pass")}
                        </Label>
                        <p className="text-xs text-muted-foreground">
                            {i18n(
                                "These settings apply only when the Summary provider is pinned in this profile. Otherwise the person running it uses their own multi-pass preference.",
                            )}
                        </p>
                    </div>
                    <Switch
                        id="summary-multi-pass"
                        checked={step.multiPass.enabled}
                        disabled={readOnly || !step.enabled}
                        onCheckedChange={(checked) =>
                            updateSettings((next) => {
                                next.steps.summary.multiPass.enabled = checked;
                            })
                        }
                    />
                </div>
                {step.multiPass.enabled && (
                    <>
                        <div className="space-y-2">
                            <Label htmlFor="multi-pass-rounds">
                                {i18n("Passes")}
                            </Label>
                            <Input
                                id="multi-pass-rounds"
                                type="number"
                                min={MULTI_PASS_ROUNDS_MIN}
                                max={MULTI_PASS_ROUNDS_MAX}
                                value={step.multiPass.rounds}
                                disabled={readOnly}
                                onChange={(event) =>
                                    updateSettings((next) => {
                                        next.steps.summary.multiPass.rounds =
                                            Number(event.target.value);
                                    })
                                }
                            />
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <Label htmlFor="multi-pass-automatic">
                                {i18n("Also use for automatic runs")}
                            </Label>
                            <Switch
                                id="multi-pass-automatic"
                                checked={step.multiPass.automaticToo}
                                disabled={readOnly}
                                onCheckedChange={(checked) =>
                                    updateSettings((next) => {
                                        next.steps.summary.multiPass.automaticToo =
                                            checked;
                                    })
                                }
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="multi-pass-merge-prompt">
                                {i18n("Merge prompt")}
                            </Label>
                            <textarea
                                id="multi-pass-merge-prompt"
                                className="min-h-24 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm"
                                value={step.multiPass.mergePrompt ?? ""}
                                disabled={readOnly}
                                onChange={(event) =>
                                    updateSettings((next) => {
                                        next.steps.summary.multiPass.mergePrompt =
                                            event.target.value || null;
                                    })
                                }
                            />
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
