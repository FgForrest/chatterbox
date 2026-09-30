"use client";

import { Boxes, ChevronRight, FileUp, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ImportDialog } from "@/components/almanac/import-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getApiErrorMessage } from "@/lib/api-errors";

export interface ThingSummary {
    id: string;
    name: string;
    typeKey: string;
    description: string | null;
    scope: "personal" | "org";
}

/**
 * The things the viewer's Almanac knows: organizations, projects, products,
 * terms and the rest. Searched by name, narrowed by type; a thing is added
 * here, or many at once from a pasted list.
 */
export function ThingsList({
    things,
    typeLabels,
    types,
}: {
    things: ThingSummary[];
    typeLabels: Record<string, string>;
    /** The types a new thing may take. */
    types: { key: string; label: string }[];
}) {
    const i18n = useExtracted();
    const router = useRouter();
    const [query, setQuery] = useState("");
    const [typeFilter, setTypeFilter] = useState("");
    const [creating, setCreating] = useState(false);
    const [importing, setImporting] = useState(false);
    const [typeKey, setTypeKey] = useState(types[0]?.key ?? "");
    const [name, setName] = useState("");
    const [nicknames, setNicknames] = useState("");
    const [description, setDescription] = useState("");
    const [saving, setSaving] = useState(false);

    // A type no thing has any more (after an erase) filters nothing.
    const activeType = things.some((thing) => thing.typeKey === typeFilter)
        ? typeFilter
        : "";
    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return things.filter(
            (thing) =>
                (!activeType || thing.typeKey === activeType) &&
                (!needle ||
                    thing.name.toLowerCase().includes(needle) ||
                    thing.description?.toLowerCase().includes(needle)),
        );
    }, [things, query, activeType]);
    // Only the types some thing has, to filter by.
    const typesInUse = useMemo(
        () =>
            [...new Set(things.map((thing) => thing.typeKey))].sort((a, b) =>
                (typeLabels[a] ?? a).localeCompare(typeLabels[b] ?? b),
            ),
        [things, typeLabels],
    );

    async function create() {
        if (!name.trim() || !typeKey || saving) return;
        setSaving(true);
        try {
            const response = await fetch("/api/knowledge/entities", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    typeKey,
                    name: name.trim(),
                    description: description.trim() || null,
                    nicknames: nicknames
                        .split(",")
                        .map((nickname) => nickname.trim())
                        .filter(Boolean),
                }),
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not add this thing"),
                    ),
                );
                return;
            }
            toast.success(i18n("{name} added", { name: name.trim() }));
            setName("");
            setNicknames("");
            setDescription("");
            setCreating(false);
            router.refresh();
        } finally {
            setSaving(false);
        }
    }

    const creator = (
        <form
            className="grid gap-3 rounded-xl border border-primary/20 bg-primary/[0.04] p-4 shadow-sm sm:grid-cols-2"
            onSubmit={(event) => {
                event.preventDefault();
                void create();
            }}
        >
            <label className="space-y-1.5 text-sm" htmlFor="thing-type">
                <span className="font-medium">{i18n("Kind of thing")}</span>
                <select
                    id="thing-type"
                    value={typeKey}
                    onChange={(event) => setTypeKey(event.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    {types.map((type) => (
                        <option key={type.key} value={type.key}>
                            {type.label}
                        </option>
                    ))}
                </select>
            </label>
            <label className="space-y-1.5 text-sm" htmlFor="thing-name">
                <span className="font-medium">{i18n("Name")}</span>
                <Input
                    id="thing-name"
                    autoFocus
                    value={name}
                    maxLength={200}
                    onChange={(event) => setName(event.target.value)}
                    className="bg-background"
                />
            </label>
            <label className="space-y-1.5 text-sm" htmlFor="thing-nicknames">
                <span className="font-medium">
                    {i18n("Nicknames (optional, separated by commas)")}
                </span>
                <Input
                    id="thing-nicknames"
                    value={nicknames}
                    onChange={(event) => setNicknames(event.target.value)}
                    className="bg-background"
                />
            </label>
            <label className="space-y-1.5 text-sm" htmlFor="thing-description">
                <span className="font-medium">
                    {i18n("Description (optional)")}
                </span>
                <Input
                    id="thing-description"
                    value={description}
                    maxLength={4000}
                    onChange={(event) => setDescription(event.target.value)}
                    className="bg-background"
                />
            </label>
            <div className="flex justify-end gap-2 sm:col-span-2">
                <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setCreating(false)}
                >
                    {i18n("Cancel")}
                </Button>
                <Button type="submit" disabled={!name.trim() || saving}>
                    {saving ? i18n("Adding…") : i18n("Add thing")}
                </Button>
            </div>
        </form>
    );

    const actions = (
        <div className="flex shrink-0 gap-2">
            <Button
                variant="outline"
                onClick={() => setCreating(!creating)}
                aria-expanded={creating}
            >
                <Plus className="size-4" />
                {creating ? i18n("Cancel") : i18n("Add thing")}
            </Button>
            <Button variant="outline" onClick={() => setImporting(true)}>
                <FileUp className="size-4" /> {i18n("Import a list")}
            </Button>
        </div>
    );

    return (
        <div className="space-y-5 pb-12">
            {things.length === 0 ? (
                <section className="rounded-2xl border bg-card px-6 py-14 text-center shadow-sm">
                    <div className="mx-auto flex max-w-lg flex-col items-center gap-3">
                        <div className="grid size-14 place-items-center rounded-2xl border bg-background shadow-sm">
                            <Boxes className="size-6 text-primary" />
                        </div>
                        <h1 className="text-balance text-2xl font-semibold tracking-tight">
                            {i18n("What do your recordings talk about?")}
                        </h1>
                        <p className="text-pretty text-sm leading-6 text-foreground/70">
                            {i18n(
                                "Organizations, projects, products and terms. Learn corrects their misheard names and proposes facts about them.",
                            )}
                        </p>
                        {!creating && actions}
                    </div>
                    {creating && (
                        <div className="mt-6 text-left">{creator}</div>
                    )}
                </section>
            ) : (
                <>
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                        <p className="text-sm font-medium">
                            {i18n(
                                "{count, plural, one {# thing} other {# things}}",
                                { count: things.length },
                            )}
                        </p>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <div className="relative min-w-0 sm:w-64">
                                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                    value={query}
                                    onChange={(event) =>
                                        setQuery(event.target.value)
                                    }
                                    placeholder={i18n("Search things")}
                                    aria-label={i18n("Search things")}
                                    className="bg-card pl-9 shadow-xs"
                                />
                            </div>
                            <select
                                value={activeType}
                                onChange={(event) =>
                                    setTypeFilter(event.target.value)
                                }
                                aria-label={i18n("Kind of thing")}
                                className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                <option value="">{i18n("All types")}</option>
                                {typesInUse.map((key) => (
                                    <option key={key} value={key}>
                                        {typeLabels[key] ?? key}
                                    </option>
                                ))}
                            </select>
                            {actions}
                        </div>
                    </div>
                    {creating && creator}
                    {filtered.length === 0 ? (
                        <p className="rounded-xl border bg-card px-6 py-10 text-center text-sm text-foreground/70">
                            {i18n("Nothing matches “{query}”.", { query })}
                        </p>
                    ) : (
                        <ul className="divide-y rounded-xl border bg-card shadow-sm">
                            {filtered.map((thing) => (
                                <li key={thing.id}>
                                    <Link
                                        href={`/almanac/things/${thing.id}`}
                                        className="group flex items-center gap-3 px-4 py-3 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                                    >
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate font-medium">
                                                {thing.name}
                                            </span>
                                            {thing.description && (
                                                <span className="block truncate text-xs text-foreground/70">
                                                    {thing.description}
                                                </span>
                                            )}
                                        </span>
                                        <span className="shrink-0 text-xs text-muted-foreground">
                                            {typeLabels[thing.typeKey] ??
                                                thing.typeKey}
                                            {thing.scope === "org" &&
                                                ` · ${i18n("Organization")}`}
                                        </span>
                                        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                </>
            )}
            <ImportDialog
                open={importing}
                onOpenChange={setImporting}
                typeLabels={typeLabels}
            />
        </div>
    );
}
