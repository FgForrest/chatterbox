"use client";

import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type { ProviderListItem } from "@/lib/ai/list-providers";
import {
    isEnhancementOnlyProvider,
    isTranscriptionOnlyProvider,
} from "@/lib/ai/provider-presets";

type Role = "transcription" | "topics" | "learning" | "summary";
const FOLLOW_SUMMARY = "__follow-summary__";

const endpoints: Record<Role, string> = {
    transcription: "/api/settings/ai/providers/default-transcription",
    topics: "/api/settings/ai/providers/default-topics",
    learning: "/api/settings/ai/providers/default-learn",
    summary: "/api/settings/ai/providers/default-enhancement",
};

export function ProviderRoleSelect({ purpose }: { purpose: Role }) {
    const i18n = useExtracted();
    const [providers, setProviders] = useState<ProviderListItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let active = true;
        fetch("/api/settings/ai/providers")
            .then((response) => {
                if (!response.ok) throw new Error("Failed to load providers");
                return response.json() as Promise<{
                    providers: ProviderListItem[];
                }>;
            })
            .then((data) => {
                if (active) setProviders(data.providers);
            })
            .catch(() => {
                if (active) toast.error(i18n("Failed to refresh providers"));
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => {
            active = false;
        };
    }, [i18n]);

    const options = providers.filter((provider) =>
        purpose === "transcription"
            ? provider.managed === true ||
              !isEnhancementOnlyProvider(provider.provider)
            : provider.managed !== true &&
              !isTranscriptionOnlyProvider(provider.provider),
    );
    const selected = providers.find((provider) =>
        purpose === "transcription"
            ? provider.isDefaultTranscription
            : purpose === "topics"
              ? provider.isDefaultTopics
              : purpose === "learning"
                ? provider.isDefaultLearn
                : provider.isDefaultEnhancement,
    );
    const label =
        purpose === "transcription"
            ? i18n("Transcription provider")
            : purpose === "topics"
              ? i18n("Topics provider")
              : purpose === "learning"
                ? i18n("Learning provider")
                : i18n("Summary provider");

    const save = async (id: string) => {
        setSaving(true);
        try {
            const response = await fetch(endpoints[purpose], {
                method: id === FOLLOW_SUMMARY ? "DELETE" : "PUT",
                ...(id === FOLLOW_SUMMARY
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
            const refreshed = await fetch("/api/settings/ai/providers");
            if (!refreshed.ok) throw new Error("Failed to refresh providers");
            const data = (await refreshed.json()) as {
                providers: ProviderListItem[];
            };
            setProviders(data.providers);
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

    return (
        <div className="space-y-2">
            <Label htmlFor={`${purpose}-provider`}>{label}</Label>
            <Select
                value={
                    selected?.id ??
                    (purpose === "topics" || purpose === "learning"
                        ? FOLLOW_SUMMARY
                        : "")
                }
                onValueChange={(id) => void save(id)}
                disabled={loading || saving || options.length === 0}
            >
                <SelectTrigger id={`${purpose}-provider`} className="w-full">
                    <SelectValue
                        placeholder={
                            options.length === 0
                                ? i18n("No provider can do this yet")
                                : i18n("Not chosen")
                        }
                    />
                </SelectTrigger>
                <SelectContent>
                    {(purpose === "topics" || purpose === "learning") && (
                        <SelectItem value={FOLLOW_SUMMARY}>
                            {i18n("Same as summaries")}
                        </SelectItem>
                    )}
                    {options.map((provider) => (
                        <SelectItem
                            key={provider.id}
                            value={provider.id}
                            disabled={provider.available === false}
                        >
                            {provider.defaultModel
                                ? `${provider.provider} · ${provider.defaultModel}`
                                : provider.provider}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}
