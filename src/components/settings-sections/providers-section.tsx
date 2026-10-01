"use client";

import {
    Bot,
    Copy,
    FileText,
    GraduationCap,
    ListChecks,
    ListTree,
    type LucideIcon,
    Pencil,
    Plus,
    Trash2,
} from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import { AddProviderDialog } from "@/components/settings/add-provider-dialog";
import { EditProviderDialog } from "@/components/settings/edit-provider-dialog";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { Button } from "@/components/ui/button";

interface Provider {
    id: string;
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
    isDefaultTranscription: boolean;
    isDefaultEnhancement: boolean;
    isDefaultTopics?: boolean;
    /** Present only where this instance has Learn. */
    isDefaultLearn?: boolean;
    createdAt: Date;
    managed?: boolean;
    includedSeconds?: number;
    available?: boolean;
}

const EMPTY_PROVIDERS: Provider[] = [];

/**
 * One line that tells two rows of the same provider apart: duplicates of
 * Claude Code or Codex differ only by model.
 */
function providerLabel(provider: Provider): string {
    return provider.defaultModel
        ? `${provider.provider} · ${provider.defaultModel}`
        : provider.provider;
}

interface ProvidersSectionProps {
    initialProviders?: Provider[];
    isHosted?: boolean;
}

/**
 * AI Providers settings section.
 *
 * Configured providers with duplicate, edit, and delete actions. Each AI
 * feature selects its provider in its own settings section.
 *
 * Note: `initialProviders` is the server-rendered seed only. The local
 * `providers` state diverges from it after add/edit/delete actions; we do
 * NOT re-sync from the prop on changes (would clobber local edits). If the
 * parent ever needs to force a reset, pass a `key` prop instead.
 */
export function ProvidersSection({
    initialProviders = EMPTY_PROVIDERS,
    isHosted = false,
}: ProvidersSectionProps) {
    const i18n = useExtracted();
    const confirm = useConfirm();
    const [providers, setProviders] = useState<Provider[]>(initialProviders);
    /**
     * `initialProviders` can arrive *after* mount. The dashboard fetches
     * the list when the settings dialog opens (`workstation.tsx`), but
     * `<Dialog open>` mounts this section in that same render, so the seed
     * is `[]` for the first moment and `useState` ignores every later prop
     * value. That left the list permanently empty on a fresh page load --
     * until an add or delete replaced the state from a response, which is
     * why re-adding appeared to "find" the missing providers.
     *
     * So adopt the prop until this component starts managing the list
     * itself; from then on local state wins, which is the invariant the
     * note above is protecting.
     */
    const selfManaged = useRef(false);
    useEffect(() => {
        if (!selfManaged.current) setProviders(initialProviders);
    }, [initialProviders]);
    const [isAddProviderOpen, setIsAddProviderOpen] = useState(false);
    const [isEditProviderOpen, setIsEditProviderOpen] = useState(false);
    const [editingProvider, setEditingProvider] = useState<Provider | null>(
        null,
    );
    const [editMode, setEditMode] = useState<"edit" | "duplicate">("edit");
    const [deletingId, setDeletingId] = useState<string | null>(null);

    const refreshProviders = async () => {
        try {
            const response = await fetch("/api/settings/ai/providers");
            if (!response.ok) throw new Error("Failed to fetch");
            const data = (await response.json()) as { providers: Provider[] };
            selfManaged.current = true;
            setProviders(data.providers);
        } catch {
            toast.error(i18n("Failed to refresh providers"));
        }
    };

    const handleEdit = (provider: Provider) => {
        setEditMode("edit");
        setEditingProvider(provider);
        setIsEditProviderOpen(true);
    };

    /** Same form as edit, saved as a new row that reuses this one's key. */
    const handleDuplicate = (provider: Provider) => {
        setEditMode("duplicate");
        setEditingProvider(provider);
        setIsEditProviderOpen(true);
    };

    const handleDelete = (id: string) => {
        void confirm({
            title: i18n("Delete this provider?"),
            description: i18n(
                "Its API key will be removed from this account. Recordings transcribed or summarized through it keep their data, but you'll need to re-add the provider to use it again.",
            ),
            confirmLabel: i18n("Delete"),
            pendingLabel: i18n("Deleting…"),
            destructive: true,
            onConfirm: async () => {
                setDeletingId(id);
                try {
                    const response = await fetch(
                        `/api/settings/ai/providers/${id}`,
                        { method: "DELETE" },
                    );
                    if (!response.ok) {
                        const error = (await response
                            .json()
                            .catch(() => ({}))) as {
                            error?: string;
                        };
                        throw new Error(error.error || "Failed to delete");
                    }
                    toast.success(i18n("Provider deleted successfully"));
                    await refreshProviders();
                } finally {
                    setDeletingId(null);
                }
            },
        });
    };

    return (
        <>
            <div className="space-y-6">
                <SettingsSectionHeader
                    title={i18n("AI Providers")}
                    description={i18n(
                        "Connect providers for transcription, topics, learning, and summaries.",
                    )}
                    icon={Bot}
                    action={
                        <Button
                            onClick={() => setIsAddProviderOpen(true)}
                            size="sm"
                        >
                            <Plus className="size-4" /> {i18n("Add Provider")}
                        </Button>
                    }
                />

                <ProvidersList
                    providers={providers}
                    deletingId={deletingId}
                    onAdd={() => setIsAddProviderOpen(true)}
                    onEdit={handleEdit}
                    onDuplicate={handleDuplicate}
                    onDelete={handleDelete}
                />
            </div>

            <AddProviderDialog
                open={isAddProviderOpen}
                onOpenChange={setIsAddProviderOpen}
                isHosted={isHosted}
                onSuccess={() => {
                    setIsAddProviderOpen(false);
                    refreshProviders();
                }}
            />

            <EditProviderDialog
                open={isEditProviderOpen}
                onOpenChange={(open) => {
                    setIsEditProviderOpen(open);
                    if (!open) {
                        setEditingProvider(null);
                    }
                }}
                provider={editingProvider}
                mode={editMode}
                isHosted={isHosted}
                onSuccess={() => {
                    setIsEditProviderOpen(false);
                    setEditingProvider(null);
                    refreshProviders();
                }}
            />
        </>
    );
}

/** A role a provider currently holds, as a quiet status chip. */
function RoleChip({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
    return (
        <span className="inline-flex items-center gap-1 rounded-full border bg-muted/60 px-2 py-0.5 text-xs text-foreground">
            <Icon className="size-3 text-muted-foreground" aria-hidden="true" />
            {label}
        </span>
    );
}

/**
 * Configured-providers list with duplicate/edit/delete row actions. Pure
 * presentation -- the parent owns the data + dialog state.
 */
function ProvidersList({
    providers,
    deletingId,
    onAdd,
    onEdit,
    onDuplicate,
    onDelete,
}: {
    providers: Provider[];
    deletingId: string | null;
    onAdd: () => void;
    onEdit: (provider: Provider) => void;
    onDuplicate: (provider: Provider) => void;
    onDelete: (id: string) => void;
}) {
    const i18n = useExtracted();
    if (providers.length === 0) {
        return (
            <div className="text-center py-12">
                <Bot className="size-16 mx-auto mb-4 text-muted-foreground" />
                <h3 className="font-semibold mb-2">
                    {i18n("No providers configured")}
                </h3>
                <p className="text-sm text-muted-foreground mb-4">
                    {i18n("Add an AI provider to enable transcription")}
                </p>
                <Button onClick={onAdd} size="sm">
                    <Plus className="size-4" /> {i18n("Add Provider")}
                </Button>
            </div>
        );
    }
    return (
        <ul className="space-y-2">
            {providers.map((provider) => {
                const roles = (
                    <>
                        {provider.isDefaultTranscription && (
                            <RoleChip
                                icon={FileText}
                                label={i18n("Transcription")}
                            />
                        )}
                        {provider.isDefaultEnhancement && (
                            <RoleChip
                                icon={ListChecks}
                                label={i18n("Summaries")}
                            />
                        )}
                        {provider.isDefaultLearn && (
                            <RoleChip
                                icon={GraduationCap}
                                label={i18n("Learn")}
                            />
                        )}
                        {provider.isDefaultTopics && (
                            <RoleChip icon={ListTree} label={i18n("Topics")} />
                        )}
                    </>
                );

                if (provider.managed === true) {
                    return (
                        <li
                            key={provider.id}
                            className="rounded-lg border px-4 py-3"
                        >
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <h3 className="font-semibold">
                                    {provider.provider}
                                </h3>
                                <span className="text-xs text-muted-foreground">
                                    {provider.available === false
                                        ? i18n(
                                              "Not in your current plan. Resubscribe to use it.",
                                          )
                                        : provider.includedSeconds
                                          ? i18n(
                                                "Up to {hours}h of transcription per month",
                                                {
                                                    hours: String(
                                                        Math.round(
                                                            provider.includedSeconds /
                                                                3600,
                                                        ),
                                                    ),
                                                },
                                            )
                                          : i18n(
                                                "Included with your subscription",
                                            )}
                                </span>
                            </div>
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                <span className="inline-flex items-center rounded-full border bg-muted/60 px-2 py-0.5 text-xs text-foreground">
                                    {i18n("Included with your plan")}
                                </span>
                                {roles}
                            </div>
                        </li>
                    );
                }

                const deleting = deletingId === provider.id;
                return (
                    <li
                        key={provider.id}
                        className="flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-start"
                    >
                        <div className="min-w-0 flex-1 space-y-1.5">
                            <h3 className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                <span className="font-semibold">
                                    {provider.provider}
                                </span>
                                {provider.defaultModel && (
                                    <span className="min-w-0 break-all font-mono text-sm text-muted-foreground">
                                        {provider.defaultModel}
                                    </span>
                                )}
                            </h3>
                            {provider.baseUrl && (
                                <p className="truncate font-mono text-xs text-muted-foreground">
                                    {provider.baseUrl}
                                </p>
                            )}
                            {(provider.isDefaultTranscription ||
                                provider.isDefaultEnhancement ||
                                provider.isDefaultLearn ||
                                provider.isDefaultTopics) && (
                                <div className="flex flex-wrap gap-1.5">
                                    {roles}
                                </div>
                            )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1 self-end sm:self-start">
                            <Button
                                onClick={() => onDuplicate(provider)}
                                variant="ghost"
                                size="icon-sm"
                                aria-label={i18n("Duplicate {name}", {
                                    name: providerLabel(provider),
                                })}
                                title={i18n(
                                    "Duplicate: another model on the same key",
                                )}
                            >
                                <Copy className="size-4" />
                            </Button>
                            <Button
                                onClick={() => onEdit(provider)}
                                variant="ghost"
                                size="icon-sm"
                                aria-label={i18n("Edit {name}", {
                                    name: providerLabel(provider),
                                })}
                                title={i18n("Edit")}
                            >
                                <Pencil className="size-4" />
                            </Button>
                            <Button
                                onClick={() => onDelete(provider.id)}
                                variant="ghost"
                                size="icon-sm"
                                disabled={deleting}
                                aria-label={i18n("Delete {name}", {
                                    name: providerLabel(provider),
                                })}
                                title={i18n("Delete")}
                                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:text-destructive"
                            >
                                {deleting ? (
                                    <div className="animate-spin size-4 border-2 border-destructive border-t-transparent rounded-full" />
                                ) : (
                                    <Trash2 className="size-4" />
                                )}
                            </Button>
                        </div>
                    </li>
                );
            })}
        </ul>
    );
}
