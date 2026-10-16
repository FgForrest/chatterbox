"use client";

import { Pencil, Plus, Power, PowerOff, Trash2 } from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import {
    EMPTY_PRICING,
    type PricingDraft,
    ProviderPriceLine,
    ProviderPricingFields,
    pricingDraft,
    pricingPayload,
} from "@/components/settings/provider-pricing-fields";
import { TranscriptionModelPicker } from "@/components/settings/transcription-model-picker";
import { Button } from "@/components/ui/button";
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
import { findPreset, getVisiblePresets } from "@/lib/ai/provider-presets";
import type { AiRate } from "@/lib/ai/published-rates";

interface OrganizationProvider {
    id: string;
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
    rate: AiRate | null;
    disabledAt: string | null;
}

interface MemberUsage {
    userId: string;
    email: string;
    calls: number;
    estimatedCostUsd: string;
}

interface OrganizationProviderDialogProps {
    provider: OrganizationProvider | null;
    open: boolean;
    isHosted: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved: () => void;
}

function providerLabel(provider: OrganizationProvider): string {
    return provider.defaultModel
        ? `${provider.provider} · ${provider.defaultModel}`
        : provider.provider;
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

function OrganizationProviderDialog({
    provider: editing,
    open,
    isHosted,
    onOpenChange,
    onSaved,
}: OrganizationProviderDialogProps) {
    const i18n = useExtracted();
    const presets = getVisiblePresets({ isHosted });
    const [provider, setProvider] = useState("");
    const [apiKey, setApiKey] = useState("");
    const [baseUrl, setBaseUrl] = useState("");
    const [defaultModel, setDefaultModel] = useState("");
    const [pricing, setPricing] = useState<PricingDraft>(EMPTY_PRICING);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;
        setProvider(editing?.provider ?? "");
        setApiKey("");
        setBaseUrl(editing?.baseUrl ?? "");
        setDefaultModel(editing?.defaultModel ?? "");
        setPricing(pricingDraft(editing?.rate));
    }, [editing, open]);

    const changeProvider = (value: string) => {
        setProvider(value);
        const preset = findPreset(value);
        if (preset) {
            setBaseUrl(preset.baseUrl);
            setDefaultModel(preset.defaultModel);
        }
    };

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!provider || (!editing && !apiKey.trim())) {
            toast.error(i18n("Provider and API key are required"));
            return;
        }
        const rate = pricingPayload(provider, pricing);
        if (!rate) {
            toast.error(i18n("Enter both token prices, or neither."));
            return;
        }
        setSaving(true);
        try {
            const response = await fetch(
                editing
                    ? `/api/settings/ai/organization-providers/${encodeURIComponent(editing.id)}`
                    : "/api/settings/ai/organization-providers",
                {
                    method: editing ? "PUT" : "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        ...rate,
                        ...(!editing ? { provider } : {}),
                        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
                        baseUrl: baseUrl || null,
                        defaultModel: defaultModel || null,
                    }),
                },
            );
            const body: unknown = await response.json().catch(() => null);
            if (!response.ok) {
                throw new Error(
                    errorMessage(
                        body,
                        i18n("Could not save the Organization provider."),
                    ),
                );
            }
            toast.success(
                editing
                    ? i18n("Organization provider updated.")
                    : i18n("Organization provider created."),
            );
            onSaved();
            onOpenChange(false);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Could not save the Organization provider."),
            );
        } finally {
            setSaving(false);
        }
    };

    const selectedPreset = findPreset(provider);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>
                        {editing
                            ? i18n("Edit Organization provider")
                            : i18n("Add Organization provider")}
                    </DialogTitle>
                    <DialogDescription>
                        {editing
                            ? i18n(
                                  "The saved key is never shown. Enter a new key only to replace it.",
                              )
                            : i18n(
                                  "Members may send content to this provider when a profile uses it.",
                              )}
                    </DialogDescription>
                </DialogHeader>
                <form className="space-y-4" onSubmit={submit}>
                    <div className="space-y-2">
                        <Label>{i18n("Provider")}</Label>
                        <Select
                            value={provider}
                            disabled={editing !== null || saving}
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
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="organization-provider-key">
                            {i18n("API Key")}
                        </Label>
                        <Input
                            id="organization-provider-key"
                            type="password"
                            autoComplete="new-password"
                            value={apiKey}
                            disabled={saving}
                            placeholder={
                                editing
                                    ? i18n(
                                          "Leave blank to keep the current key",
                                      )
                                    : selectedPreset?.placeholder ||
                                      i18n("Your API key")
                            }
                            onChange={(event) => setApiKey(event.target.value)}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="organization-provider-base-url">
                            {i18n("Base URL (Optional)")}
                        </Label>
                        <Input
                            id="organization-provider-base-url"
                            value={baseUrl}
                            disabled={saving}
                            placeholder={i18n("https://api.example.com/v1")}
                            onChange={(event) => setBaseUrl(event.target.value)}
                        />
                    </div>
                    <TranscriptionModelPicker
                        preset={selectedPreset}
                        apiKey={apiKey}
                        baseUrl={baseUrl}
                        value={defaultModel}
                        onChange={setDefaultModel}
                        disabled={saving}
                    />
                    <ProviderPricingFields
                        provider={provider}
                        model={defaultModel}
                        baseUrl={baseUrl}
                        value={pricing}
                        onChange={setPricing}
                        disabled={saving}
                    />
                    <div className="flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            disabled={saving}
                            onClick={() => onOpenChange(false)}
                        >
                            {i18n("Cancel")}
                        </Button>
                        <Button type="submit" disabled={saving}>
                            {saving ? i18n("Saving…") : i18n("Save")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** Organization-owned AI credentials, permissions, and member usage. */
export function OrganizationProvidersCard({ isHosted }: { isHosted: boolean }) {
    const i18n = useExtracted();
    const locale = useLocale();
    const confirm = useConfirm();
    const [providers, setProviders] = useState<OrganizationProvider[]>([]);
    const [usage, setUsage] = useState<MemberUsage[]>([]);
    const [canManage, setCanManage] = useState(false);
    const [available, setAvailable] = useState<boolean | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editing, setEditing] = useState<OrganizationProvider | null>(null);
    const [mutatingId, setMutatingId] = useState<string | null>(null);

    const load = useCallback(async () => {
        const listResponse = await fetch(
            "/api/settings/ai/organization-providers",
        ).catch(() => null);
        if (!listResponse?.ok) {
            setAvailable(false);
            return;
        }
        const list = (await listResponse.json()) as {
            providers: OrganizationProvider[];
        };
        setProviders(list.providers);
        const usageResponse = await fetch(
            "/api/settings/ai/organization-providers/usage",
        ).catch(() => null);
        if (usageResponse?.ok) {
            const body = (await usageResponse.json()) as {
                members: MemberUsage[];
            };
            setCanManage(true);
            setUsage(body.members);
        } else {
            setCanManage(false);
            setUsage([]);
        }
        setAvailable(true);
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const changeDisabled = async (provider: OrganizationProvider) => {
        setMutatingId(provider.id);
        try {
            const response = await fetch(
                `/api/settings/ai/organization-providers/${encodeURIComponent(provider.id)}`,
                {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        disabled: provider.disabledAt === null,
                    }),
                },
            );
            if (!response.ok) {
                const body: unknown = await response.json().catch(() => null);
                throw new Error(
                    errorMessage(
                        body,
                        i18n("Could not update the Organization provider."),
                    ),
                );
            }
            await load();
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Could not update the Organization provider."),
            );
        } finally {
            setMutatingId(null);
        }
    };

    const remove = (provider: OrganizationProvider) => {
        void confirm({
            title: i18n("Delete this Organization provider?"),
            description: i18n(
                "Profiles that pin it will stop with an error until another provider is selected.",
            ),
            confirmLabel: i18n("Delete"),
            pendingLabel: i18n("Deleting…"),
            destructive: true,
            onConfirm: async () => {
                const response = await fetch(
                    `/api/settings/ai/organization-providers/${encodeURIComponent(provider.id)}`,
                    { method: "DELETE" },
                );
                if (!response.ok) {
                    const body: unknown = await response
                        .json()
                        .catch(() => null);
                    throw new Error(
                        errorMessage(
                            body,
                            i18n("Could not delete the Organization provider."),
                        ),
                    );
                }
                await load();
            },
            errorMessage: i18n("Could not delete the Organization provider."),
        });
    };

    if (available !== true) return null;
    const currency = new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 4,
    });

    return (
        <section className="space-y-4 border-t pt-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <div className="flex items-center gap-2">
                        <h3 className="text-base font-semibold">
                            {i18n("Organization providers")}
                        </h3>
                        {!canManage && (
                            <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
                                {i18n("Read-only")}
                            </span>
                        )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                        {i18n(
                            "Shared credentials that Organization profiles may use. Keys are write-only.",
                        )}
                    </p>
                </div>
                {canManage && (
                    <Button
                        type="button"
                        size="sm"
                        aria-label={i18n("Add organization provider")}
                        onClick={() => {
                            setEditing(null);
                            setDialogOpen(true);
                        }}
                    >
                        <Plus className="size-4" />
                        {i18n("Add provider")}
                    </Button>
                )}
            </div>

            {providers.length === 0 ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    {i18n("No Organization providers configured.")}
                </p>
            ) : (
                <ul className="space-y-2">
                    {providers.map((provider) => {
                        const label = providerLabel(provider);
                        const disabled = provider.disabledAt !== null;
                        return (
                            <li
                                key={provider.id}
                                className="flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-start"
                            >
                                <div className="min-w-0 flex-1 space-y-1.5">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-semibold">
                                            {provider.provider}
                                        </span>
                                        {provider.defaultModel && (
                                            <span className="break-all font-mono text-sm text-muted-foreground">
                                                {provider.defaultModel}
                                            </span>
                                        )}
                                        {disabled && (
                                            <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
                                                {i18n("Disabled")}
                                            </span>
                                        )}
                                    </div>
                                    {provider.baseUrl && (
                                        <p className="truncate font-mono text-xs text-muted-foreground">
                                            {provider.baseUrl}
                                        </p>
                                    )}
                                    <ProviderPriceLine
                                        provider={provider.provider}
                                        model={provider.defaultModel}
                                        baseUrl={provider.baseUrl}
                                        rate={provider.rate}
                                    />
                                </div>
                                {canManage && (
                                    <div className="flex shrink-0 gap-1 self-end sm:self-start">
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={i18n("Edit {name}", {
                                                name: label,
                                            })}
                                            onClick={() => {
                                                setEditing(provider);
                                                setDialogOpen(true);
                                            }}
                                        >
                                            <Pencil className="size-4" />
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-sm"
                                            disabled={
                                                mutatingId === provider.id
                                            }
                                            aria-label={
                                                disabled
                                                    ? i18n("Enable {name}", {
                                                          name: label,
                                                      })
                                                    : i18n("Disable {name}", {
                                                          name: label,
                                                      })
                                            }
                                            onClick={() =>
                                                void changeDisabled(provider)
                                            }
                                        >
                                            {disabled ? (
                                                <Power className="size-4" />
                                            ) : (
                                                <PowerOff className="size-4" />
                                            )}
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={i18n("Delete {name}", {
                                                name: label,
                                            })}
                                            onClick={() => remove(provider)}
                                        >
                                            <Trash2 className="size-4" />
                                        </Button>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}

            {canManage && (
                <div className="space-y-2">
                    <h4 className="text-sm font-medium">
                        {i18n("Usage per member")}
                    </h4>
                    {usage.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            {i18n("No Organization provider usage yet.")}
                        </p>
                    ) : (
                        <div className="overflow-x-auto rounded-lg border">
                            <table className="w-full text-left text-sm">
                                <thead className="bg-muted/50 text-muted-foreground">
                                    <tr>
                                        <th className="px-3 py-2 font-medium">
                                            {i18n("Member")}
                                        </th>
                                        <th className="px-3 py-2 text-right font-medium">
                                            {i18n("Calls")}
                                        </th>
                                        <th className="px-3 py-2 text-right font-medium">
                                            {i18n("Estimated cost")}
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y">
                                    {usage.map((member) => (
                                        <tr key={member.userId}>
                                            <td className="px-3 py-2">
                                                {member.email}
                                            </td>
                                            <td className="px-3 py-2 text-right tabular-nums">
                                                {member.calls}
                                            </td>
                                            <td className="px-3 py-2 text-right tabular-nums">
                                                {currency.format(
                                                    Number(
                                                        member.estimatedCostUsd,
                                                    ),
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            <OrganizationProviderDialog
                provider={editing}
                open={dialogOpen}
                isHosted={isHosted}
                onOpenChange={setDialogOpen}
                onSaved={() => void load()}
            />
        </section>
    );
}
