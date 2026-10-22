"use client";

import { Command } from "cmdk";
import { Check } from "lucide-react";
import { useExtracted } from "next-intl";

interface MergeTarget {
    id: string;
    name: string;
    email?: string | null;
    scope?: "personal" | "org";
    badge?: string;
}

function searchKey(value: string): string {
    return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/** Choose a merge destination with the Almanac's searchable command list. */
export function MergeTargetPicker({
    candidates,
    value,
    onChange,
}: {
    candidates: readonly MergeTarget[];
    value: string;
    onChange: (id: string) => void;
}) {
    const i18n = useExtracted();
    return (
        <Command
            label={i18n("Merge target")}
            className="rounded-md border"
            filter={(_value, search, keywords) =>
                searchKey((keywords ?? []).join(" ")).includes(
                    searchKey(search),
                )
                    ? 1
                    : 0
            }
        >
            <Command.Input
                autoFocus
                onValueChange={() => onChange("")}
                aria-label={i18n("Merge target")}
                placeholder={i18n("Search by name or email")}
                className="h-9 w-full border-b bg-transparent px-3 text-sm outline-none"
            />
            <Command.List className="max-h-56 overflow-y-auto p-1">
                <Command.Empty className="px-2 py-3 text-sm text-muted-foreground">
                    {i18n("No matches.")}
                </Command.Empty>
                {candidates.map((candidate) => (
                    <Command.Item
                        key={candidate.id}
                        value={candidate.id}
                        keywords={[candidate.name, candidate.email ?? ""]}
                        onSelect={() => onChange(candidate.id)}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm data-[selected=true]:bg-muted"
                    >
                        <span className="min-w-0 flex-1">
                            <span className="block truncate">
                                {candidate.name}
                            </span>
                            {candidate.email && (
                                <span className="block truncate text-xs text-muted-foreground">
                                    {candidate.email}
                                </span>
                            )}
                        </span>
                        {(candidate.scope || candidate.badge) && (
                            <span
                                className={
                                    candidate.scope === "org" &&
                                    !candidate.badge
                                        ? "shrink-0 rounded-full border border-organization/20 bg-organization/5 px-1.5 py-0.5 text-[10px] leading-none text-organization"
                                        : "shrink-0 rounded-full border border-primary/20 bg-primary/5 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
                                }
                            >
                                {candidate.badge ??
                                    (candidate.scope === "org"
                                        ? i18n("Organization")
                                        : i18n("Private"))}
                            </span>
                        )}
                        <Check
                            aria-hidden="true"
                            className={`size-4 shrink-0 text-primary ${value === candidate.id ? "opacity-100" : "opacity-0"}`}
                        />
                        {value === candidate.id && (
                            <span className="sr-only">{i18n("Selected")}</span>
                        )}
                    </Command.Item>
                ))}
            </Command.List>
        </Command>
    );
}
