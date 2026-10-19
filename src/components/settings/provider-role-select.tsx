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
import {
    defaultProviderCandidates,
    providerPointersFromFlags,
} from "@/lib/ai/provider-resolution-order";

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

function available(provider: PickerProvider, purpose: Role): boolean {
    return (
        supports(provider, purpose) &&
        provider.disabledAt == null &&
        provider.available !== false
    );
}

interface ProviderResponse {
    providers: PickerProvider[];
    defaults?: DefaultProviderPointers;
}

const EMPTY_DEFAULTS: DefaultProviderPointers = {
    transcription: null,
    summary: null,
    learn: null,
    topics: null,
    title: null,
};

/** Choose one account default from personal and Organization providers. */
export function ProviderRoleSelect({ purpose }: { purpose: Role }) {
    const i18n = useExtracted();
    const [personal, setPersonal] = useState<PickerProvider[]>([]);
    const [organization, setOrganization] = useState<PickerProvider[]>([]);
    const [defaults, setDefaults] = useState<DefaultProviderPointers | null>(
        null,
    );
    const [organizationPointers, setOrganizationPointers] =
        useState<DefaultProviderPointers>(EMPTY_DEFAULTS);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        const personalResponse = await fetch(
            "/api/settings/ai/providers?includeDisabled=true",
        );
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
            setOrganizationPointers(EMPTY_DEFAULTS);
            return;
        }
        const organizationBody =
            (await organizationResponse.json()) as ProviderResponse;
        setOrganization(organizationBody.providers);
        setOrganizationPointers(
            organizationBody.defaults ??
                providerPointersFromFlags(organizationBody.providers),
        );
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
        available(provider, purpose),
    );
    const organizationOptions = organization.filter((provider) =>
        available(provider, purpose),
    );
    const selectedId = defaults?.[role] ?? null;
    const followsSummary =
        purpose === "topics" || purpose === "learning" || purpose === "title";
    const [candidate] = defaultProviderCandidates(
        role,
        defaults ?? EMPTY_DEFAULTS,
        organizationPointers,
        personal,
        organization,
    );
    const candidateProvider = candidate
        ? [...personal, ...organization].find(
              (provider) => provider.id === candidate.providerId,
          )
        : undefined;
    const candidateUnavailable = Boolean(
        candidate &&
            (!candidateProvider || !available(candidateProvider, purpose)),
    );
    let value = NOT_CHOSEN;
    if (candidate?.source === "member-role") value = candidate.providerId;
    if (candidate?.source === "member-summary") value = FOLLOW_SUMMARY;
    if (
        candidate?.source === "organization-role" ||
        candidate?.source === "organization-summary"
    ) {
        value = ORGANIZATION_DEFAULT;
    }
    const organizationDefaultId =
        organizationPointers[role] ??
        (followsSummary ? organizationPointers.summary : null);
    const organizationDefault = organization.find(
        (provider) => provider.id === organizationDefaultId,
    );
    const organizationDefaultAvailable = organizationDefault
        ? available(organizationDefault, purpose)
        : false;
    const automaticProvider =
        candidate?.source === "member-fallback" ||
        candidate?.source === "organization-fallback"
            ? candidateProvider
            : undefined;

    const save = async (id: string) => {
        if (id === NOT_CHOSEN && !selectedId) return;
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
    const selectValue = value;
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
                disabled={
                    loading || saving || (noOptions && !candidateUnavailable)
                }
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
                    {candidateUnavailable && (
                        <SelectItem value={value} disabled>
                            {candidateProvider
                                ? i18n("Unavailable: {provider}", {
                                      provider:
                                          providerLabel(candidateProvider),
                                  })
                                : i18n("Unavailable: deleted provider")}
                        </SelectItem>
                    )}
                    {followsSummary &&
                        defaults?.summary &&
                        !(candidateUnavailable && value === FOLLOW_SUMMARY) && (
                            <SelectItem value={FOLLOW_SUMMARY}>
                                {i18n("Same as summaries")}
                            </SelectItem>
                        )}
                    {organizationDefault &&
                        organizationDefaultAvailable &&
                        !(
                            candidateUnavailable &&
                            value === ORGANIZATION_DEFAULT
                        ) && (
                            <SelectItem value={ORGANIZATION_DEFAULT}>
                                {i18n("Organization default: {provider}", {
                                    provider:
                                        providerLabel(organizationDefault),
                                })}
                            </SelectItem>
                        )}
                    {!candidateUnavailable &&
                        !selectedId &&
                        !organizationDefaultAvailable &&
                        automaticProvider && (
                            <SelectItem value={NOT_CHOSEN} disabled>
                                {i18n("Automatic: {provider}", {
                                    provider: providerLabel(automaticProvider),
                                })}
                            </SelectItem>
                        )}
                    {purpose === "transcription" &&
                        !organizationDefaultAvailable &&
                        !noOptions &&
                        !automaticProvider && (
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
            {organization.length > 0 && !loading && (
                <p className="text-xs text-muted-foreground">
                    {purpose === "transcription"
                        ? i18n(
                              "Without a choice, transcription uses the Organization default, then its oldest enabled transcription provider.",
                          )
                        : followsSummary
                          ? i18n(
                                "Without a role choice, Learn, topics and titles try your summary choice first. Then come the Organization defaults, your first enabled chat provider, and the Organization’s oldest enabled chat provider.",
                            )
                          : i18n(
                                "Without a choice, summaries use the Organization default, then your first enabled chat provider, then the Organization’s oldest enabled chat provider.",
                            )}
                </p>
            )}
            {candidateUnavailable && !loading && (
                <p className="text-xs text-muted-foreground">
                    {i18n(
                        "This default is unavailable. Choose another provider.",
                    )}
                </p>
            )}
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
