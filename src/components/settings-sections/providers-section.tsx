"use client";

import { Bot } from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import {
    ProviderCard,
    type ProviderCardItem,
    type ProviderMemberUsage,
    type ProviderScope,
} from "@/components/settings/provider-card";
import {
    ProviderFormDialog,
    type ProviderFormMode,
} from "@/components/settings/provider-form-dialog";
import { SettingsSectionHeader } from "@/components/settings/section-header";

interface ProvidersSectionProps {
    initialProviders?: ProviderCardItem[];
    isHosted?: boolean;
}

interface DialogState {
    scope: ProviderScope;
    mode: ProviderFormMode;
    provider: ProviderCardItem | null;
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

function providerRoles(
    provider: ProviderCardItem,
    i18n: (message: string) => string,
): string[] {
    const roles: string[] = [];
    if (provider.isDefaultTranscription) roles.push(i18n("Transcription"));
    if (provider.isDefaultEnhancement) roles.push(i18n("Summaries"));
    if (provider.isDefaultLearn) roles.push(i18n("Learn"));
    if (provider.isDefaultTopics) roles.push(i18n("Topics"));
    if (provider.isDefaultTitle) roles.push(i18n("Titles"));
    return roles;
}

function providerEndpoint(scope: ProviderScope, id: string): string {
    const collection =
        scope === "personal"
            ? "/api/settings/ai/providers"
            : "/api/settings/ai/organization-providers";
    return `${collection}/${encodeURIComponent(id)}`;
}

/** AI provider settings for personal and Organization credentials. */
export function ProvidersSection({
    initialProviders = [],
    isHosted = false,
}: ProvidersSectionProps) {
    const i18n = useExtracted();
    const locale = useLocale();
    const confirm = useConfirm();
    const selfManaged = useRef(false);
    const [personalProviders, setPersonalProviders] =
        useState<ProviderCardItem[]>(initialProviders);
    const [organizationProviders, setOrganizationProviders] = useState<
        ProviderCardItem[]
    >([]);
    const [organizationUsage, setOrganizationUsage] = useState<
        ProviderMemberUsage[]
    >([]);
    const [organizationAvailable, setOrganizationAvailable] = useState(false);
    const [canManageOrganization, setCanManageOrganization] = useState(false);
    const [dialog, setDialog] = useState<DialogState | null>(null);
    const [busy, setBusy] = useState<{
        scope: ProviderScope;
        id: string;
    } | null>(null);

    useEffect(() => {
        if (!selfManaged.current) setPersonalProviders(initialProviders);
    }, [initialProviders]);

    const loadPersonal = useCallback(async () => {
        const response = await fetch(
            "/api/settings/ai/providers?includeDisabled=true",
        );
        if (!response.ok) throw new Error("Failed to fetch providers");
        const body = (await response.json()) as {
            providers: ProviderCardItem[];
        };
        selfManaged.current = true;
        setPersonalProviders(body.providers);
    }, []);

    const loadOrganization = useCallback(async () => {
        const listResponse = await fetch(
            "/api/settings/ai/organization-providers",
        ).catch(() => null);
        if (!listResponse?.ok) {
            setOrganizationAvailable(false);
            return;
        }
        const list = (await listResponse.json()) as {
            providers: ProviderCardItem[];
        };
        setOrganizationProviders(list.providers);
        setOrganizationAvailable(true);

        const usageResponse = await fetch(
            "/api/settings/ai/organization-providers/usage",
        ).catch(() => null);
        if (!usageResponse?.ok) {
            setCanManageOrganization(false);
            setOrganizationUsage([]);
            return;
        }
        const usage = (await usageResponse.json()) as {
            members: ProviderMemberUsage[];
        };
        setCanManageOrganization(true);
        setOrganizationUsage(usage.members);
    }, []);

    useEffect(() => {
        void loadPersonal().catch(() => {
            toast.error(i18n("Failed to refresh providers"));
        });
        void loadOrganization();
    }, [i18n, loadOrganization, loadPersonal]);

    const reload = async (scope: ProviderScope) => {
        if (scope === "personal") {
            await loadPersonal();
            return;
        }
        await loadOrganization();
    };

    const mutateDisabled = async (
        scope: ProviderScope,
        provider: ProviderCardItem,
    ) => {
        setBusy({ scope, id: provider.id });
        try {
            const response = await fetch(providerEndpoint(scope, provider.id), {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ disabled: provider.disabledAt == null }),
            });
            const body: unknown = await response.json().catch(() => null);
            if (!response.ok) {
                throw new Error(
                    errorMessage(body, i18n("Could not update the provider.")),
                );
            }
            await reload(scope);
        } finally {
            setBusy(null);
        }
    };

    const toggleDisabled = (
        scope: ProviderScope,
        provider: ProviderCardItem,
    ) => {
        if (provider.disabledAt != null) {
            void mutateDisabled(scope, provider).catch((error: unknown) => {
                toast.error(
                    error instanceof Error
                        ? error.message
                        : i18n("Could not update the provider."),
                );
            });
            return;
        }

        let description = i18n(
            "Profiles that use it stop with an error until it is enabled again.",
        );
        if (scope === "personal") {
            const roles = providerRoles(provider, i18n);
            description = i18n(
                "Nothing uses it now. It stays saved but is not offered until you enable it again.",
            );
            if (roles.length > 0) {
                const names = new Intl.ListFormat(locale, {
                    style: "long",
                    type: "conjunction",
                }).format(roles);
                description = i18n(
                    "{roles} use this provider. They stop with an error until you enable it again or choose another provider.",
                    { roles: names },
                );
            }
        }

        void confirm({
            title: i18n("Disable {provider}?", {
                provider: provider.provider,
            }),
            description,
            confirmLabel: i18n("Disable"),
            pendingLabel: i18n("Disabling…"),
            onConfirm: () => mutateDisabled(scope, provider),
            errorMessage: i18n("Could not disable the provider."),
        });
    };

    const remove = (scope: ProviderScope, provider: ProviderCardItem) => {
        const organization = scope === "organization";
        const title = organization
            ? i18n("Delete this Organization provider?")
            : i18n("Delete this provider?");
        const description = organization
            ? i18n(
                  "Profiles that pin it will stop with an error until another provider is selected.",
              )
            : i18n(
                  "Its API key will be removed from this account. Recordings transcribed or summarized through it keep their data, but you'll need to re-add the provider to use it again.",
              );
        void confirm({
            title,
            description,
            confirmLabel: i18n("Delete"),
            pendingLabel: i18n("Deleting…"),
            destructive: true,
            onConfirm: async () => {
                setBusy({ scope, id: provider.id });
                try {
                    const response = await fetch(
                        providerEndpoint(scope, provider.id),
                        { method: "DELETE" },
                    );
                    const body: unknown = await response
                        .json()
                        .catch(() => null);
                    if (!response.ok) {
                        throw new Error(
                            errorMessage(
                                body,
                                i18n("Could not delete the provider."),
                            ),
                        );
                    }
                    await reload(scope);
                } finally {
                    setBusy(null);
                }
            },
            errorMessage: i18n("Could not delete the provider."),
        });
    };

    const openDialog = (
        scope: ProviderScope,
        mode: ProviderFormMode,
        provider: ProviderCardItem | null,
    ) => setDialog({ scope, mode, provider });

    return (
        <>
            <div className="space-y-6">
                <SettingsSectionHeader
                    title={i18n("AI providers")}
                    description={i18n(
                        "Connect providers for transcription, topics, learning, and summaries.",
                    )}
                    icon={Bot}
                />
                <ProviderCard
                    scope="personal"
                    providers={personalProviders}
                    canManage
                    busyId={busy?.scope === "personal" ? busy.id : null}
                    locale={locale}
                    onAdd={() => openDialog("personal", "add", null)}
                    onDuplicate={(provider) =>
                        openDialog("personal", "duplicate", provider)
                    }
                    onEdit={(provider) =>
                        openDialog("personal", "edit", provider)
                    }
                    onToggleDisabled={(provider) =>
                        toggleDisabled("personal", provider)
                    }
                    onDelete={(provider) => remove("personal", provider)}
                />
                {organizationAvailable && (
                    <ProviderCard
                        scope="organization"
                        providers={organizationProviders}
                        canManage={canManageOrganization}
                        busyId={busy?.scope === "organization" ? busy.id : null}
                        usage={organizationUsage}
                        locale={locale}
                        onAdd={() => openDialog("organization", "add", null)}
                        onDuplicate={(provider) =>
                            openDialog("organization", "duplicate", provider)
                        }
                        onEdit={(provider) =>
                            openDialog("organization", "edit", provider)
                        }
                        onToggleDisabled={(provider) =>
                            toggleDisabled("organization", provider)
                        }
                        onDelete={(provider) =>
                            remove("organization", provider)
                        }
                    />
                )}
            </div>
            {dialog && (
                <ProviderFormDialog
                    scope={dialog.scope}
                    mode={dialog.mode}
                    provider={dialog.provider}
                    open
                    isHosted={isHosted}
                    onOpenChange={(open) => {
                        if (!open) setDialog(null);
                    }}
                    onSuccess={() => {
                        void reload(dialog.scope);
                    }}
                />
            )}
        </>
    );
}
