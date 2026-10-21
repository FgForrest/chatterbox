"use client";

import {
    Copy,
    FileText,
    GraduationCap,
    ListChecks,
    ListTree,
    Pencil,
    Plus,
    Power,
    PowerOff,
    Trash2,
    UserRound,
    Users,
} from "lucide-react";
import { useExtracted } from "next-intl";
import { ProviderPriceLine } from "@/components/settings/provider-pricing-fields";
import { Button } from "@/components/ui/button";
import type { DefaultProviderPointers } from "@/lib/ai/default-provider";
import {
    oldestSuitableProvider,
    providerPointersFromFlags,
} from "@/lib/ai/provider-resolution-order";
import type { AiRate } from "@/lib/ai/published-rates";
import { cn } from "@/lib/utils";

export type ProviderScope = "personal" | "organization";

export interface ProviderCardItem {
    id: string;
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
    maxOutputTokens?: number | null;
    rate?: AiRate | null;
    disabledAt?: Date | string | null;
    isDefaultTranscription?: boolean;
    isDefaultEnhancement?: boolean;
    isDefaultTopics?: boolean;
    isDefaultTitle?: boolean;
    isDefaultLearn?: boolean;
    managed?: boolean;
    includedSeconds?: number;
    available?: boolean;
    createdAt?: Date | string;
}

export interface ProviderMemberUsage {
    userId: string;
    email: string;
    calls: number;
    estimatedCostUsd: string;
}

interface ProviderCardProps {
    scope: ProviderScope;
    providers: ProviderCardItem[];
    canManage: boolean;
    busyId: string | null;
    usage?: ProviderMemberUsage[];
    locale: string;
    organizationDefaults?: DefaultProviderPointers;
    fallbackUsage?: Partial<Record<"transcription" | "summary", string>>;
    onMakeDefault?: (
        provider: ProviderCardItem,
        role: "transcription" | "summary",
    ) => void;
    onAdd: () => void;
    onDuplicate: (provider: ProviderCardItem) => void;
    onEdit: (provider: ProviderCardItem) => void;
    onToggleDisabled: (provider: ProviderCardItem) => void;
    onDelete: (provider: ProviderCardItem) => void;
}

function providerLabel(provider: ProviderCardItem): string {
    if (!provider.defaultModel) return provider.provider;
    return `${provider.provider} · ${provider.defaultModel}`;
}

function RoleChip({
    icon: Icon,
    label,
}: {
    icon: typeof FileText;
    label: string;
}) {
    return (
        <span className="inline-flex items-center gap-1 rounded-full border bg-muted/60 px-2 py-0.5 text-xs text-foreground">
            <Icon className="size-3 text-muted-foreground" aria-hidden="true" />
            {label}
        </span>
    );
}

function ManagedProviderDetails({ provider }: { provider: ProviderCardItem }) {
    const i18n = useExtracted();
    let description = i18n("Included with your subscription");
    if (provider.available === false) {
        description = i18n("Not in your current plan. Resubscribe to use it.");
    } else if (provider.includedSeconds) {
        description = i18n("Up to {hours}h of transcription per month", {
            hours: String(Math.round(provider.includedSeconds / 3600)),
        });
    }
    return (
        <>
            <span className="text-xs text-muted-foreground">{description}</span>
            <span className="inline-flex items-center rounded-full border bg-muted/60 px-2 py-0.5 text-xs text-foreground">
                {i18n("Included with your plan")}
            </span>
        </>
    );
}

function ProviderRow({
    scope,
    provider,
    canManage,
    busy,
    fallbackUsage,
    onDuplicate,
    onEdit,
    onToggleDisabled,
    onDelete,
}: {
    scope: ProviderScope;
    provider: ProviderCardItem;
    canManage: boolean;
    busy: boolean;
    fallbackUsage?: Partial<Record<"transcription" | "summary", string>>;
    onDuplicate: (provider: ProviderCardItem) => void;
    onEdit: (provider: ProviderCardItem) => void;
    onToggleDisabled: (provider: ProviderCardItem) => void;
    onDelete: (provider: ProviderCardItem) => void;
}) {
    const i18n = useExtracted();
    const label = providerLabel(provider);
    const disabled = provider.disabledAt != null;
    const managed = provider.managed === true;
    const organizationDefault =
        scope === "organization" &&
        (provider.isDefaultTranscription === true ||
            provider.isDefaultEnhancement === true ||
            provider.isDefaultLearn === true ||
            provider.isDefaultTopics === true ||
            provider.isDefaultTitle === true);
    const actionLabel = disabled ? i18n("Enable") : i18n("Disable");
    const actionAria = disabled
        ? i18n("Enable {name}", { name: label })
        : i18n("Disable {name}", { name: label });

    return (
        <li className="flex flex-col gap-3 rounded-lg border bg-background/40 px-4 py-3 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-semibold">{provider.provider}</span>
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
                    {disabled && organizationDefault && (
                        <span className="rounded border border-destructive/40 bg-destructive/5 px-1.5 py-0.5 text-xs text-destructive">
                            {i18n("Disabled Organization default")}
                        </span>
                    )}
                    {managed && <ManagedProviderDetails provider={provider} />}
                </div>
                {provider.baseUrl && (
                    <p className="truncate font-mono text-xs text-muted-foreground">
                        {provider.baseUrl}
                    </p>
                )}
                {!managed && (
                    <ProviderPriceLine
                        provider={provider.provider}
                        model={provider.defaultModel}
                        baseUrl={provider.baseUrl}
                        rate={provider.rate}
                    />
                )}
                <div className="flex flex-wrap gap-1.5">
                    {scope === "organization" &&
                        !canManage &&
                        fallbackUsage?.transcription === provider.id && (
                            <RoleChip
                                icon={FileText}
                                label={i18n("Used for your transcription")}
                            />
                        )}
                    {scope === "organization" &&
                        !canManage &&
                        fallbackUsage?.summary === provider.id && (
                            <RoleChip
                                icon={ListChecks}
                                label={i18n("Used for your summaries")}
                            />
                        )}
                    {provider.isDefaultTranscription && (
                        <RoleChip
                            icon={FileText}
                            label={i18n("Transcription")}
                        />
                    )}
                    {provider.isDefaultEnhancement && (
                        <RoleChip icon={ListChecks} label={i18n("Summaries")} />
                    )}
                    {provider.isDefaultLearn && (
                        <RoleChip icon={GraduationCap} label={i18n("Learn")} />
                    )}
                    {provider.isDefaultTopics && (
                        <RoleChip icon={ListTree} label={i18n("Topics")} />
                    )}
                    {provider.isDefaultTitle && (
                        <RoleChip icon={Pencil} label={i18n("Titles")} />
                    )}
                </div>
            </div>
            {canManage && !managed && (
                <div className="flex shrink-0 items-center gap-1 self-end sm:self-start">
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        title={i18n("Duplicate")}
                        aria-label={i18n("Duplicate {name}", { name: label })}
                        disabled={busy}
                        onClick={() => onDuplicate(provider)}
                    >
                        <Copy className="size-4" />
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        title={i18n("Edit")}
                        aria-label={i18n("Edit {name}", { name: label })}
                        disabled={busy}
                        onClick={() => onEdit(provider)}
                    >
                        <Pencil className="size-4" />
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        title={actionLabel}
                        aria-label={actionAria}
                        disabled={busy}
                        onClick={() => onToggleDisabled(provider)}
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
                        title={i18n("Delete")}
                        aria-label={i18n("Delete {name}", { name: label })}
                        disabled={busy}
                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:text-destructive"
                        onClick={() => onDelete(provider)}
                    >
                        <Trash2 className="size-4" />
                    </Button>
                </div>
            )}
        </li>
    );
}

function UsageTable({
    usage,
    locale,
}: {
    usage: ProviderMemberUsage[];
    locale: string;
}) {
    const i18n = useExtracted();
    const currency = new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 4,
    });
    return (
        <div className="space-y-2 border-t pt-3">
            <h4 className="text-sm font-medium">{i18n("Usage per member")}</h4>
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
                                            Number(member.estimatedCostUsd),
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

/** Shared AI provider card for personal and Organization credentials. */
export function ProviderCard({
    scope,
    providers,
    canManage,
    busyId,
    usage = [],
    locale,
    organizationDefaults,
    fallbackUsage,
    onMakeDefault,
    onAdd,
    onDuplicate,
    onEdit,
    onToggleDisabled,
    onDelete,
}: ProviderCardProps) {
    const i18n = useExtracted();
    const organization = scope === "organization";
    const title = organization
        ? i18n("Organization providers")
        : i18n("Your providers");
    const description = organization
        ? i18n(
              "Shared with every member. Organization defaults apply until a member chooses another provider. Keys are write-only.",
          )
        : i18n("Only you can use these keys.");
    const empty = organization
        ? i18n("No Organization providers yet.")
        : i18n("No providers yet. Add one to transcribe and summarize.");
    const Icon = organization ? Users : UserRound;
    const pointers =
        organizationDefaults ?? providerPointersFromFlags(providers);
    const credentials = providers.map((provider) => ({
        ...provider,
        createdAt: provider.createdAt ?? new Date(0),
    }));

    return (
        <section
            aria-label={title}
            className={cn(
                "rounded-lg border bg-card/40 px-4 py-3.5",
                organization && "border-primary/35 bg-primary/[0.025]",
            )}
        >
            <div className="flex items-start justify-between gap-4 pb-3">
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <Icon
                            className={cn(
                                "size-4 text-muted-foreground",
                                organization && "text-primary",
                            )}
                            aria-hidden="true"
                            data-testid={`${scope}-provider-icon`}
                        />
                        <span>{title}</span>
                        {organization && !canManage && (
                            <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
                                {i18n("Read-only")}
                            </span>
                        )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {description}
                    </p>
                </div>
                {canManage && (
                    <Button
                        type="button"
                        size="sm"
                        aria-label={
                            organization
                                ? i18n("Add organization provider")
                                : i18n("Add personal provider")
                        }
                        onClick={onAdd}
                    >
                        <Plus className="size-4" />
                        {i18n("Add provider")}
                    </Button>
                )}
            </div>
            {organization && canManage && (
                <div className="space-y-2 pb-3">
                    {(["transcription", "summary"] as const).map((role) => {
                        if (pointers[role]) return null;
                        const fallback = oldestSuitableProvider(
                            role,
                            credentials,
                        );
                        return (
                            <div
                                key={role}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs"
                            >
                                <p>
                                    {fallback
                                        ? role === "transcription"
                                            ? i18n(
                                                  "No Organization default for transcription. Members without their own choice use {name}.",
                                                  {
                                                      name: providerLabel(
                                                          fallback,
                                                      ),
                                                  },
                                              )
                                            : i18n(
                                                  "No Organization default for summaries. Members without their own choice use {name}.",
                                                  {
                                                      name: providerLabel(
                                                          fallback,
                                                      ),
                                                  },
                                              )
                                        : role === "transcription"
                                          ? i18n(
                                                "Members without their own provider cannot transcribe. Add an Organization provider or choose a default.",
                                            )
                                          : i18n(
                                                "Members without their own provider cannot summarize. Add an Organization provider or choose a default.",
                                            )}
                                </p>
                                {fallback && onMakeDefault && (
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        disabled={busyId !== null}
                                        aria-label={
                                            role === "transcription"
                                                ? i18n(
                                                      "Make Organization default for transcription",
                                                  )
                                                : i18n(
                                                      "Make Organization default for summaries",
                                                  )
                                        }
                                        onClick={() =>
                                            onMakeDefault(fallback, role)
                                        }
                                    >
                                        {i18n("Make default")}
                                    </Button>
                                )}
                            </div>
                        );
                    })}
                    {!pointers.summary && (
                        <p className="text-xs text-muted-foreground">
                            {i18n(
                                "Learn, topics and titles follow summaries unless chosen separately.",
                            )}
                        </p>
                    )}
                </div>
            )}
            {providers.length === 0 ? (
                <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                    {empty}
                </p>
            ) : (
                <ul className="space-y-2">
                    {providers.map((provider) => (
                        <ProviderRow
                            key={provider.id}
                            scope={scope}
                            provider={provider}
                            canManage={canManage}
                            busy={busyId === provider.id}
                            fallbackUsage={fallbackUsage}
                            onDuplicate={onDuplicate}
                            onEdit={onEdit}
                            onToggleDisabled={onToggleDisabled}
                            onDelete={onDelete}
                        />
                    ))}
                </ul>
            )}
            {organization && canManage && (
                <div className="mt-3">
                    <UsageTable usage={usage} locale={locale} />
                </div>
            )}
        </section>
    );
}
