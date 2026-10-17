"use client";

import { useExtracted } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type {
    DefaultProviderPointers,
    ProviderRole,
} from "@/lib/ai/default-provider";
import type { ProviderListItem } from "@/lib/ai/list-providers";
import {
    isEnhancementOnlyProvider,
    isTranscriptionOnlyProvider,
} from "@/lib/ai/provider-presets";

type Role = "transcription" | "topics" | "learning" | "summary" | "title";
type PickerProvider = ProviderListItem & { scope?: "organization" };

const FOLLOW_SUMMARY = "__follow-summary__";
const ORGANIZATION_DEFAULT = "__organization-default__";
const NOT_CHOSEN = "__not-chosen__";

const endpoints: Record<Role, string> = {
    transcription: "/api/settings/ai/providers/default-transcription",
    topics: "/api/settings/ai/providers/default-topics",
    learning: "/api/settings/ai/providers/default-learn",
    summary: "/api/settings/ai/providers/default-enhancement",
    title: "/api/settings/ai/providers/default-title",
};

function storageRole(purpose: Role): ProviderRole {
    return purpose === "learning" ? "learn" : purpose;
}

function providerLabel(provider: PickerProvider): string {
    return provider.defaultModel
        ? `${provider.provider} · ${provider.defaultModel}`
        : provider.provider;
}

function supports(provider: PickerProvider, purpose: Role): boolean {
    if (provider.disabledAt != null || provider.available === false)
        return false;
    if (purpose === "transcription") {
        return (
            provider.managed === true ||
            !isEnhancementOnlyProvider(provider.provider)
        );
    }
    return (
        provider.managed !== true &&
        !isTranscriptionOnlyProvider(provider.provider)
    );
}

function isOrganizationDefault(
    provider: PickerProvider,
    purpose: Role,
): boolean {
    if (purpose === "transcription") return provider.isDefaultTranscription;
    if (purpose === "summary") return provider.isDefaultEnhancement;
    if (purpose === "learning") return provider.isDefaultLearn === true;
    if (purpose === "topics") return provider.isDefaultTopics === true;
    return provider.isDefaultTitle === true;
}

interface ProviderResponse {
    providers: PickerProvider[];
    defaults?: DefaultProviderPointers;
}

/** Choose one account default from personal and Organization providers. */
export function ProviderRoleSelect({ purpose }: { purpose: Role }) {
    const i18n = useExtracted();
    const [personal, setPersonal] = useState<PickerProvider[]>([]);
    const [organization, setOrganization] = useState<PickerProvider[]>([]);
    const [defaults, setDefaults] = useState<DefaultProviderPointers | null>(
        null,
    );
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        const personalResponse = await fetch("/api/settings/ai/providers");
        if (!personalResponse.ok) throw new Error("Failed to load providers");
        const personalBody =
            (await personalResponse.json()) as ProviderResponse;
        setPersonal(personalBody.providers);
        setDefaults(personalBody.defaults ?? null);

        const organizationResponse = await fetch(
            "/api/settings/ai/organization-providers",
        ).catch(() => null);
        if (!organizationResponse?.ok) {
            setOrganization([]);
            return;
        }
        const organizationBody =
            (await organizationResponse.json()) as ProviderResponse;
        setOrganization(organizationBody.providers);
    }, []);

    useEffect(() => {
        let active = true;
        void load()
            .catch(() => {
                if (active) toast.error(i18n("Failed to refresh providers"));
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => {
            active = false;
        };
    }, [i18n, load]);

    const role = storageRole(purpose);
    const personalOptions = personal.filter((provider) =>
        supports(provider, purpose),
    );
    const organizationOptions = organization.filter((provider) =>
        supports(provider, purpose),
    );
    const selectedId =
        defaults?.[role] ??
        personal.find((provider) => isOrganizationDefault(provider, purpose))
            ?.id ??
        null;
    const organizationDefault = organizationOptions.find((provider) =>
        isOrganizationDefault(provider, purpose),
    );
    const followsSummary =
        purpose === "topics" || purpose === "learning" || purpose === "title";
    let value = selectedId ?? NOT_CHOSEN;
    if (
        !selectedId &&
        organizationDefault &&
        (!followsSummary || !defaults?.summary)
    ) {
        value = ORGANIZATION_DEFAULT;
    } else if (!selectedId && followsSummary) {
        value = FOLLOW_SUMMARY;
    }

    const save = async (id: string) => {
        setSaving(true);
        try {
            const clear =
                id === FOLLOW_SUMMARY ||
                id === ORGANIZATION_DEFAULT ||
                id === NOT_CHOSEN;
            const response = await fetch(endpoints[purpose], {
                method: clear ? "DELETE" : "PUT",
                ...(clear
                    ? {}
                    : {
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ providerId: id }),
                      }),
            });
            if (!response.ok) {
                const body = (await response.json().catch(() => ({}))) as {
                    error?: string;
                };
                throw new Error(body.error ?? "Failed to save provider");
            }
            await load();
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Failed to update default"),
            );
        } finally {
            setSaving(false);
        }
    };

    const noOptions =
        personalOptions.length === 0 && organizationOptions.length === 0;
    let selectValue: string | undefined = value;
    if (noOptions) selectValue = undefined;
    let label = i18n("Summary provider");
    if (purpose === "transcription") label = i18n("Transcription provider");
    if (purpose === "topics") label = i18n("Topics provider");
    if (purpose === "learning") label = i18n("Learning provider");
    if (purpose === "title") label = i18n("Title provider");
    return (
        <div className="space-y-2">
            <Label htmlFor={`${purpose}-provider`}>{label}</Label>
            <Select
                value={selectValue}
                onValueChange={(id) => void save(id)}
                disabled={loading || saving || noOptions}
            >
                <SelectTrigger id={`${purpose}-provider`} className="w-full">
                    <SelectValue
                        placeholder={
                            noOptions
                                ? i18n(
                                      "None of your providers or the Organization's can do this yet.",
                                  )
                                : i18n("Not chosen")
                        }
                    />
                </SelectTrigger>
                <SelectContent>
                    {followsSummary && (
                        <SelectItem value={FOLLOW_SUMMARY}>
                            {i18n("Same as summaries")}
                        </SelectItem>
                    )}
                    {organizationDefault && (
                        <SelectItem value={ORGANIZATION_DEFAULT}>
                            {i18n("Organization default: {provider}", {
                                provider: providerLabel(organizationDefault),
                            })}
                        </SelectItem>
                    )}
                    {!followsSummary && !organizationDefault && !noOptions && (
                        <SelectItem value={NOT_CHOSEN}>
                            {i18n("Not chosen")}
                        </SelectItem>
                    )}
                    {personalOptions.length > 0 && (
                        <SelectGroup>
                            <SelectLabel>{i18n("Your providers")}</SelectLabel>
                            {personalOptions.map((provider) => (
                                <SelectItem
                                    key={provider.id}
                                    value={provider.id}
                                    disabled={provider.available === false}
                                >
                                    {providerLabel(provider)}
                                </SelectItem>
                            ))}
                        </SelectGroup>
                    )}
                    {organizationOptions.length > 0 && (
                        <SelectGroup>
                            <SelectLabel>
                                {i18n("Organization providers")}
                            </SelectLabel>
                            {organizationOptions.map((provider) => (
                                <SelectItem
                                    key={provider.id}
                                    value={provider.id}
                                >
                                    {providerLabel(provider)}
                                </SelectItem>
                            ))}
                        </SelectGroup>
                    )}
                </SelectContent>
            </Select>
            {noOptions && !loading && (
                <p className="text-xs text-muted-foreground">
                    {i18n(
                        "None of your providers or the Organization's can do this yet.",
                    )}{" "}
                    <a className="underline" href="/settings?section=providers">
                        {i18n("Open Providers")}
                    </a>
                </p>
            )}
        </div>
    );
}
