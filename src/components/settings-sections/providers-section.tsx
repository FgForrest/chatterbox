"use client";

import {
    Bot,
    Copy,
    FileText,
    GraduationCap,
    ListChecks,
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
import { SettingsCard } from "@/components/settings/settings-card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    isEnhancementOnlyProvider,
    isTranscriptionOnlyProvider,
} from "@/lib/ai/provider-presets";

interface Provider {
    id: string;
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
    isDefaultTranscription: boolean;
    isDefaultEnhancement: boolean;
    /** Present only where this instance has Learn. */
    isDefaultLearn?: boolean;
    createdAt: Date;
    managed?: boolean;
    includedSeconds?: number;
    available?: boolean;
}

type Role = "transcription" | "summaries" | "learn";

const EMPTY_PROVIDERS: Provider[] = [];

/**
 * The Learn picker's "no provider of its own" choice. Radix Select needs a
 * non-empty value for every item, so the fallback gets a sentinel that no
 * credential id (a nanoid) can collide with.
 */
const LEARN_FOLLOWS_SUMMARIES = "__same-as-summaries__";

/**
 * Where each role is set on the server. Transcription and summaries have
 * no "unset" here: clearing one is an explicit act in the edit dialog,
 * not something a dropdown should make easy.
 */
const ROLE_ENDPOINTS: Record<Role, string> = {
    transcription: "/api/settings/ai/providers/default-transcription",
    summaries: "/api/settings/ai/providers/default-enhancement",
    learn: "/api/settings/ai/providers/default-learn",
};

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
 * Two parts: which provider does each job (transcription, summaries and,
 * where the instance has it, Learn), then the configured providers with
 * duplicate/edit/delete. Each job belongs to one provider at a time, so it
 * is chosen once, from a dropdown, rather than by a button on every row.
 * Local state seeded from `initialProviders` and updated in place by the
 * dialogs. Prompt templates live with the features that use them: title
 * templates in Transcription, summary templates in Summary.
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
    const [savingRole, setSavingRole] = useState<Role | null>(null);

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

    /**
     * Give a role to a provider. For Learn, `null` hands it back to the
     * summaries provider, which is what Learn uses when none is marked.
     */
    const handleAssignRole = (role: Role, providerId: string | null) => {
        const chosen = providers.find((p) => p.id === providerId);
        void (async () => {
            setSavingRole(role);
            try {
                const res = await fetch(
                    ROLE_ENDPOINTS[role],
                    providerId === null
                        ? { method: "DELETE" }
                        : {
                              method: "PUT",
                              headers: { "content-type": "application/json" },
                              body: JSON.stringify({ providerId }),
                          },
                );
                if (!res.ok) {
                    const b = (await res.json().catch(() => ({}))) as {
                        error?: string;
                    };
                    throw new Error(b.error ?? `HTTP ${res.status}`);
                }
                const name = chosen ? providerLabel(chosen) : "";
                toast.success(
                    role === "transcription"
                        ? i18n("Transcription now uses {name}", { name })
                        : role === "summaries"
                          ? i18n("Summaries now use {name}", { name })
                          : providerId === null
                            ? i18n("Learn uses the summaries provider again")
                            : i18n("Learn now uses {name}", { name }),
                );
                await refreshProviders();
            } catch (e) {
                toast.error(
                    e instanceof Error
                        ? e.message
                        : i18n("Failed to update default"),
                );
            } finally {
                setSavingRole(null);
            }
        })();
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
                        "Connect transcription and summary providers. Anything OpenAI-compatible works.",
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

                {providers.length > 0 && (
                    <RoleAssignments
                        providers={providers}
                        savingRole={savingRole}
                        onAssign={handleAssignRole}
                    />
                )}

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

/**
 * Which provider does each job. Every role belongs to one provider at a
 * time, so it is one dropdown per role, listing only the providers that
 * can do that job.
 */
function RoleAssignments({
    providers,
    savingRole,
    onAssign,
}: {
    providers: Provider[];
    savingRole: Role | null;
    onAssign: (role: Role, providerId: string | null) => void;
}) {
    const i18n = useExtracted();

    const transcribers = providers.filter(
        (p) => p.managed === true || !isEnhancementOnlyProvider(p.provider),
    );
    const summarizers = providers.filter(
        (p) => p.managed !== true && !isTranscriptionOnlyProvider(p.provider),
    );
    // `isDefaultLearn` is absent on every row where this instance has no
    // Learn, which is how the list says "don't offer the choice".
    const hasLearn = providers.some((p) => p.isDefaultLearn !== undefined);
    const learnProvider = providers.find((p) => p.isDefaultLearn === true);
    const summariesProvider = providers.find((p) => p.isDefaultEnhancement);

    return (
        <SettingsCard
            title={i18n("Used for")}
            description={i18n(
                "Each job runs on one provider. Only providers that can do the job are listed.",
            )}
        >
            <div className="grid gap-x-4 gap-y-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-start">
                <RolePicker
                    id="role-transcription"
                    icon={FileText}
                    label={i18n("Transcription")}
                    options={transcribers}
                    value={
                        providers.find((p) => p.isDefaultTranscription)?.id ??
                        ""
                    }
                    disabled={savingRole !== null}
                    onChange={(id) => onAssign("transcription", id)}
                />
                <RolePicker
                    id="role-summaries"
                    icon={ListChecks}
                    label={i18n("Summaries")}
                    options={summarizers}
                    value={summariesProvider?.id ?? ""}
                    disabled={savingRole !== null}
                    onChange={(id) => onAssign("summaries", id)}
                />
                {hasLearn && (
                    <RolePicker
                        id="role-learn"
                        icon={GraduationCap}
                        label={i18n("Learn")}
                        options={summarizers}
                        value={learnProvider?.id ?? LEARN_FOLLOWS_SUMMARIES}
                        disabled={savingRole !== null}
                        onChange={(id) =>
                            onAssign(
                                "learn",
                                id === LEARN_FOLLOWS_SUMMARIES ? null : id,
                            )
                        }
                        fallback={{
                            value: LEARN_FOLLOWS_SUMMARIES,
                            label: summariesProvider
                                ? i18n("Same as summaries ({name})", {
                                      name: providerLabel(summariesProvider),
                                  })
                                : i18n("Same as summaries"),
                        }}
                        hint={i18n(
                            "Pick a provider only when Learn should use a different model than summaries, a stronger one for example.",
                        )}
                    />
                )}
            </div>
        </SettingsCard>
    );
}

function RolePicker({
    id,
    icon: Icon,
    label,
    options,
    value,
    disabled,
    onChange,
    fallback,
    hint,
}: {
    id: string;
    icon: LucideIcon;
    label: string;
    options: Provider[];
    value: string;
    disabled: boolean;
    onChange: (id: string) => void;
    /** An extra first item that means "no provider of its own". */
    fallback?: { value: string; label: string };
    hint?: string;
}) {
    const i18n = useExtracted();
    const empty = options.length === 0 && !fallback;
    return (
        <>
            {/* Height of the select, so a hint below it can't pull the label off its line. */}
            <Label htmlFor={id} className="gap-2 sm:h-9">
                <Icon
                    className="size-4 text-muted-foreground"
                    aria-hidden="true"
                />
                {label}
            </Label>
            <div className="min-w-0 space-y-1">
                <Select
                    value={value}
                    onValueChange={(next) => {
                        if (next !== value) onChange(next);
                    }}
                    disabled={disabled || empty}
                >
                    <SelectTrigger id={id} className="w-full">
                        <SelectValue
                            placeholder={
                                empty
                                    ? i18n("No provider can do this yet")
                                    : i18n("Not chosen")
                            }
                        />
                    </SelectTrigger>
                    <SelectContent>
                        {fallback && (
                            <SelectItem value={fallback.value}>
                                {fallback.label}
                            </SelectItem>
                        )}
                        {options.map((p) => (
                            <SelectItem
                                key={p.id}
                                value={p.id}
                                disabled={p.available === false}
                            >
                                {providerLabel(p)}
                                {p.available === false &&
                                    ` (${i18n("resubscribe to use")})`}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                {hint && (
                    <p className="text-xs text-muted-foreground">{hint}</p>
                )}
            </div>
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
                                provider.isDefaultLearn) && (
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
