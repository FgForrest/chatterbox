"use client";

import { AlertTriangle, Shield } from "lucide-react";
import { useExtracted } from "next-intl";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { MetalButton } from "@/components/metal-button";
import { Panel } from "@/components/panel";
import type {
    ProviderCardItem,
    ProviderScope,
} from "@/components/settings/provider-card";
import {
    EMPTY_PRICING,
    type PricingDraft,
    ProviderPricingFields,
    pricingDraft,
    pricingPayload,
} from "@/components/settings/provider-pricing-fields";
import { TranscriptionModelPicker } from "@/components/settings/transcription-model-picker";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    findPreset,
    getVisiblePresets,
    isLocalPreset,
} from "@/lib/ai/provider-presets";

export type ProviderFormMode = "add" | "edit" | "duplicate";

interface ProviderFormDialogProps {
    scope: ProviderScope;
    mode: ProviderFormMode;
    provider: ProviderCardItem | null;
    open: boolean;
    isHosted: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: () => void;
}

function errorMessage(body: unknown, fallback: string): string {
    if (
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
    ) {
        return body.error;
    }
    return fallback;
}

function dialogTitle(
    mode: ProviderFormMode,
    i18n: (message: string) => string,
): string {
    if (mode === "add") return i18n("Add AI Provider");
    if (mode === "duplicate") return i18n("Duplicate AI Provider");
    return i18n("Edit AI Provider");
}

function submitLabel(
    mode: ProviderFormMode,
    saving: boolean,
    i18n: (message: string) => string,
): string {
    if (saving) return i18n("Saving…");
    if (mode === "add") return i18n("Add Provider");
    if (mode === "duplicate") return i18n("Add Copy");
    return i18n("Update Provider");
}

function addDefaultFlag(
    body: Record<string, unknown>,
    key:
        | "isDefaultTranscription"
        | "isDefaultEnhancement"
        | "isDefaultLearn"
        | "isDefaultTopics"
        | "isDefaultTitle",
    value: boolean,
    previous: boolean,
    mode: ProviderFormMode,
): void {
    if ((mode === "add" || mode === "duplicate") && value) body[key] = true;
    if (mode === "edit" && value !== previous) body[key] = value;
}

/** Add, edit, or duplicate a personal or Organization AI provider. */
export function ProviderFormDialog({
    scope,
    mode,
    provider: source,
    open,
    isHosted,
    onOpenChange,
    onSuccess,
}: ProviderFormDialogProps) {
    const i18n = useExtracted();
    const presets = getVisiblePresets({ isHosted });
    const editing = mode === "edit";
    const duplicating = mode === "duplicate";
    const personal = scope === "personal";
    const sourceDisabled = editing && source?.disabledAt != null;
    const [provider, setProvider] = useState("");
    const [apiKey, setApiKey] = useState("");
    const [baseUrl, setBaseUrl] = useState("");
    const [defaultModel, setDefaultModel] = useState("");
    const [isDefaultTranscription, setIsDefaultTranscription] = useState(false);
    const [isDefaultEnhancement, setIsDefaultEnhancement] = useState(false);
    const [isDefaultLearn, setIsDefaultLearn] = useState(false);
    const [isDefaultTopics, setIsDefaultTopics] = useState(false);
    const [isDefaultTitle, setIsDefaultTitle] = useState(false);
    const [pricing, setPricing] = useState<PricingDraft>(EMPTY_PRICING);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) {
            setProvider("");
            setApiKey("");
            setBaseUrl("");
            setDefaultModel("");
            setIsDefaultTranscription(false);
            setIsDefaultEnhancement(false);
            setIsDefaultLearn(false);
            setIsDefaultTopics(false);
            setIsDefaultTitle(false);
            setPricing(EMPTY_PRICING);
            return;
        }
        setProvider(source?.provider ?? "");
        setApiKey("");
        setBaseUrl(source?.baseUrl ?? "");
        setDefaultModel(source?.defaultModel ?? "");
        setIsDefaultTranscription(
            editing && source?.isDefaultTranscription === true,
        );
        setIsDefaultEnhancement(
            editing && source?.isDefaultEnhancement === true,
        );
        setIsDefaultLearn(editing && source?.isDefaultLearn === true);
        setIsDefaultTopics(editing && source?.isDefaultTopics === true);
        setIsDefaultTitle(editing && source?.isDefaultTitle === true);
        setPricing(duplicating ? EMPTY_PRICING : pricingDraft(source?.rate));
    }, [duplicating, editing, open, source]);

    const selectedPreset = findPreset(provider);
    const transcriptionOnly = selectedPreset?.transcriptionOnly === true;
    const enhancementOnly = selectedPreset?.enhancementOnly === true;
    const legacyLocalProvider =
        isHosted && source && isLocalPreset(source.provider)
            ? source.provider
            : null;

    const changeProvider = (value: string) => {
        setProvider(value);
        const preset = findPreset(value);
        if (!preset) return;
        setBaseUrl(preset.baseUrl);
        setDefaultModel(preset.defaultModel);
        if (preset.transcriptionOnly) {
            setIsDefaultEnhancement(false);
            setIsDefaultLearn(false);
            setIsDefaultTopics(false);
            setIsDefaultTitle(false);
        }
        if (preset.enhancementOnly) setIsDefaultTranscription(false);
    };

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!provider || (mode === "add" && !apiKey.trim())) {
            toast.error(i18n("Provider and API key are required"));
            return;
        }
        if (mode !== "add" && !source) {
            toast.error(i18n("Provider ID is missing"));
            return;
        }
        const rates = pricingPayload(provider, pricing);
        if (!rates) {
            toast.error(i18n("Enter both token prices, or neither."));
            return;
        }

        const collection =
            scope === "personal"
                ? "/api/settings/ai/providers"
                : "/api/settings/ai/organization-providers";
        let url = collection;
        let method = "POST";
        if (editing && source) {
            url = `${collection}/${encodeURIComponent(source.id)}`;
            method = "PUT";
        }
        const body: Record<string, unknown> = {
            ...rates,
            baseUrl: baseUrl || null,
            defaultModel: defaultModel || null,
        };
        if (mode === "add") body.provider = provider;
        if (duplicating && source) {
            body.provider = source.provider;
            body.copyKeyFrom = source.id;
        }
        if (apiKey.trim()) body.apiKey = apiKey.trim();
        addDefaultFlag(
            body,
            "isDefaultTranscription",
            isDefaultTranscription,
            source?.isDefaultTranscription === true,
            mode,
        );
        addDefaultFlag(
            body,
            "isDefaultEnhancement",
            isDefaultEnhancement,
            source?.isDefaultEnhancement === true,
            mode,
        );
        if (!personal) {
            addDefaultFlag(
                body,
                "isDefaultLearn",
                isDefaultLearn,
                source?.isDefaultLearn === true,
                mode,
            );
            addDefaultFlag(
                body,
                "isDefaultTopics",
                isDefaultTopics,
                source?.isDefaultTopics === true,
                mode,
            );
            addDefaultFlag(
                body,
                "isDefaultTitle",
                isDefaultTitle,
                source?.isDefaultTitle === true,
                mode,
            );
        }

        setSaving(true);
        try {
            const response = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const responseBody: unknown = await response
                .json()
                .catch(() => null);
            if (!response.ok) {
                throw new Error(
                    errorMessage(
                        responseBody,
                        i18n("Could not save provider."),
                    ),
                );
            }
            toast.success(i18n("AI provider saved successfully"));
            onSuccess();
            onOpenChange(false);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Could not save provider."),
            );
        } finally {
            setSaving(false);
        }
    };

    let keyPlaceholder = selectedPreset?.placeholder || i18n("Your API key");
    if (editing) keyPlaceholder = i18n("Leave blank to keep the current key");
    if (duplicating) keyPlaceholder = i18n("Leave blank to reuse the same key");

    if (!open) return null;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{dialogTitle(mode, i18n)}</DialogTitle>
                    {scope === "organization" && (
                        <DialogDescription>
                            {i18n(
                                "Members may use this provider for account defaults and Organization profiles. Keys are write-only.",
                            )}
                        </DialogDescription>
                    )}
                </DialogHeader>
                <form className="space-y-4" onSubmit={submit}>
                    <div className="space-y-2">
                        <Label>{i18n("Provider")}</Label>
                        <Select
                            value={provider}
                            disabled={mode !== "add" || saving}
                            onValueChange={changeProvider}
                        >
                            <SelectTrigger>
                                <SelectValue
                                    placeholder={i18n("Select a provider")}
                                />
                            </SelectTrigger>
                            <SelectContent>
                                {presets.map((preset) => (
                                    <SelectItem
                                        key={preset.name}
                                        value={preset.name}
                                    >
                                        {preset.name}
                                    </SelectItem>
                                ))}
                                {legacyLocalProvider && (
                                    <SelectItem
                                        value={legacyLocalProvider}
                                        disabled
                                    >
                                        {legacyLocalProvider}{" "}
                                        {i18n("(not available on hosted)")}
                                    </SelectItem>
                                )}
                            </SelectContent>
                        </Select>
                        {legacyLocalProvider && (
                            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
                                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                                <span>
                                    {i18n(
                                        "This local provider is not reachable from the hosted app. Use a public endpoint or self-host Chatterbox.",
                                    )}
                                </span>
                            </div>
                        )}
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor={`${scope}-provider-key`}>
                            {i18n("API Key")}
                        </Label>
                        <Input
                            id={`${scope}-provider-key`}
                            type="password"
                            autoComplete="new-password"
                            value={apiKey}
                            disabled={saving}
                            placeholder={keyPlaceholder}
                            className="font-mono text-sm"
                            onChange={(event) => setApiKey(event.target.value)}
                        />
                        {mode !== "add" && (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Shield className="size-3.5 shrink-0" />
                                <span>
                                    {duplicating
                                        ? i18n(
                                              "The copy reuses the saved key without showing it. Enter a key only to use a different one.",
                                          )
                                        : i18n(
                                              "The saved key is never shown. Leave this blank to keep it.",
                                          )}
                                </span>
                            </div>
                        )}
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor={`${scope}-provider-base-url`}>
                            {i18n("Base URL (Optional)")}
                        </Label>
                        <Input
                            id={`${scope}-provider-base-url`}
                            value={baseUrl}
                            disabled={saving}
                            placeholder={i18n("https://api.example.com/v1")}
                            className="font-mono text-sm"
                            onChange={(event) => setBaseUrl(event.target.value)}
                        />
                        {isHosted && (
                            <p className="text-xs text-muted-foreground">
                                {i18n(
                                    "Private and localhost addresses are not reachable from the hosted app.",
                                )}
                            </p>
                        )}
                    </div>
                    <TranscriptionModelPicker
                        preset={selectedPreset}
                        apiKey={apiKey}
                        baseUrl={baseUrl}
                        value={defaultModel}
                        onChange={setDefaultModel}
                        disabled={saving}
                    />
                    <Panel variant="inset" className="space-y-2 text-sm">
                        <label
                            className={
                                enhancementOnly
                                    ? "flex items-center gap-2 opacity-60"
                                    : "flex cursor-pointer items-center gap-2"
                            }
                        >
                            <input
                                type="checkbox"
                                checked={
                                    isDefaultTranscription && !enhancementOnly
                                }
                                disabled={
                                    saving || enhancementOnly || sourceDisabled
                                }
                                onChange={(event) =>
                                    setIsDefaultTranscription(
                                        event.target.checked,
                                    )
                                }
                            />
                            <span>
                                {personal
                                    ? i18n("Use for transcription")
                                    : i18n(
                                          "Organization default for transcription",
                                      )}
                            </span>
                        </label>
                        <label
                            className={
                                transcriptionOnly
                                    ? "flex items-center gap-2 opacity-60"
                                    : "flex cursor-pointer items-center gap-2"
                            }
                        >
                            <input
                                type="checkbox"
                                checked={
                                    isDefaultEnhancement && !transcriptionOnly
                                }
                                disabled={
                                    saving ||
                                    transcriptionOnly ||
                                    sourceDisabled
                                }
                                onChange={(event) =>
                                    setIsDefaultEnhancement(
                                        event.target.checked,
                                    )
                                }
                            />
                            <span>
                                {personal
                                    ? i18n("Use for summaries")
                                    : i18n(
                                          "Organization default for summaries",
                                      )}
                            </span>
                        </label>
                        {!personal && (
                            <>
                                <label
                                    className={
                                        transcriptionOnly
                                            ? "flex items-center gap-2 opacity-60"
                                            : "flex cursor-pointer items-center gap-2"
                                    }
                                >
                                    <input
                                        type="checkbox"
                                        checked={
                                            isDefaultLearn && !transcriptionOnly
                                        }
                                        disabled={
                                            saving ||
                                            transcriptionOnly ||
                                            sourceDisabled
                                        }
                                        onChange={(event) =>
                                            setIsDefaultLearn(
                                                event.target.checked,
                                            )
                                        }
                                    />
                                    <span>
                                        {i18n("Organization default for Learn")}
                                    </span>
                                </label>
                                <label
                                    className={
                                        transcriptionOnly
                                            ? "flex items-center gap-2 opacity-60"
                                            : "flex cursor-pointer items-center gap-2"
                                    }
                                >
                                    <input
                                        type="checkbox"
                                        checked={
                                            isDefaultTopics &&
                                            !transcriptionOnly
                                        }
                                        disabled={
                                            saving ||
                                            transcriptionOnly ||
                                            sourceDisabled
                                        }
                                        onChange={(event) =>
                                            setIsDefaultTopics(
                                                event.target.checked,
                                            )
                                        }
                                    />
                                    <span>
                                        {i18n(
                                            "Organization default for topics",
                                        )}
                                    </span>
                                </label>
                                <label
                                    className={
                                        transcriptionOnly
                                            ? "flex items-center gap-2 opacity-60"
                                            : "flex cursor-pointer items-center gap-2"
                                    }
                                >
                                    <input
                                        type="checkbox"
                                        checked={
                                            isDefaultTitle && !transcriptionOnly
                                        }
                                        disabled={
                                            saving ||
                                            transcriptionOnly ||
                                            sourceDisabled
                                        }
                                        onChange={(event) =>
                                            setIsDefaultTitle(
                                                event.target.checked,
                                            )
                                        }
                                    />
                                    <span>
                                        {i18n(
                                            "Organization default for titles",
                                        )}
                                    </span>
                                </label>
                            </>
                        )}
                    </Panel>
                    <ProviderPricingFields
                        provider={provider}
                        model={defaultModel}
                        baseUrl={baseUrl}
                        value={pricing}
                        onChange={setPricing}
                        disabled={saving}
                    />
                    <div className="flex gap-2">
                        <MetalButton
                            type="button"
                            className="flex-1"
                            disabled={saving}
                            onClick={() => onOpenChange(false)}
                        >
                            {i18n("Cancel")}
                        </MetalButton>
                        <MetalButton
                            type="submit"
                            variant="cyan"
                            className="flex-1"
                            disabled={saving}
                        >
                            {submitLabel(mode, saving, i18n)}
                        </MetalButton>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
