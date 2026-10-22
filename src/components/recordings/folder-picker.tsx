"use client";

import { Command } from "cmdk";
import { Check, Folder, Plus, Users } from "lucide-react";
import { useExtracted } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { useFolderLabel } from "@/hooks/use-folder-label";
import { useLibraryPreferences } from "@/hooks/use-library-preferences";
import { getApiErrorMessage } from "@/lib/api-errors";
import {
    joinFolderPath,
    matchFolderEntries,
    matchFolders,
} from "@/lib/folders/navigation";
import type { RecordingFolder } from "@/types/folder";

export function FolderPicker({
    folders,
    assignedIds,
    open,
    onOpenChange,
    onSelect,
    organizationOnly = false,
    sharing = false,
    scope,
    canCurate = false,
    onCreated,
}: {
    folders: RecordingFolder[];
    assignedIds: ReadonlySet<string>;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (folderId: string) => Promise<void>;
    organizationOnly?: boolean;
    sharing?: boolean;
    scope?: RecordingFolder["scope"];
    canCurate?: boolean;
    onCreated?: (folder: RecordingFolder) => void;
}) {
    const i18n = useExtracted();
    const label = useFolderLabel();
    const { recentFolders, rememberFolder } = useLibraryPreferences();
    const [query, setQuery] = useState("");
    const [creating, setCreating] = useState(false);
    const [parentId, setParentId] = useState("");
    const [saving, setSaving] = useState(false);
    const entries = useMemo(
        () =>
            matchFolders(
                folders.filter(
                    (folder) =>
                        (!organizationOnly || folder.scope === "org") &&
                        (!scope || folder.scope === scope),
                ),
                "",
                label,
            ),
        [folders, organizationOnly, scope, label],
    );
    const matches = matchFolderEntries(entries, query, label).filter(
        ({ folder }) => folder.kind !== "private",
    );
    const parents = entries.filter(
        ({ folder }) =>
            folder.scope !== "org" || folder.parentId !== null || canCurate,
    );
    const select = async (folderId: string) => {
        if (assignedIds.has(folderId) || saving) return;
        setSaving(true);
        try {
            await onSelect(folderId);
            rememberFolder(folderId);
            onOpenChange(false);
        } catch {
        } finally {
            setSaving(false);
        }
    };
    const create = async () => {
        if (!parentId || !query.trim() || saving) return;
        setSaving(true);
        try {
            const response = await fetch("/api/folders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ parentId, name: query.trim() }),
            });
            if (!response.ok)
                throw new Error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not create folder"),
                    ),
                );
            const { folder } = (await response.json()) as {
                folder: RecordingFolder;
            };
            onCreated?.(folder);
            setCreating(false);
            try {
                await onSelect(folder.id);
                rememberFolder(folder.id);
                onOpenChange(false);
            } catch {}
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Could not create folder"),
            );
        } finally {
            setSaving(false);
        }
    };
    const row = (entry: (typeof matches)[number], prefix: string) => (
        <Command.Item
            key={`${prefix}:${entry.folder.id}`}
            value={`${prefix}:${entry.folder.id}`}
            disabled={assignedIds.has(entry.folder.id) || saving}
            onSelect={() => void select(entry.folder.id)}
            className="flex cursor-default items-center gap-2 rounded px-3 py-2 text-sm data-[selected=true]:bg-accent data-[disabled=true]:opacity-50"
        >
            {entry.folder.scope === "org" ? (
                <Users className="size-4 shrink-0 text-organization" />
            ) : (
                <Folder className="size-4 shrink-0 text-primary" />
            )}
            <span
                className="min-w-0"
                style={
                    query.trim() || prefix === "recent"
                        ? undefined
                        : {
                              paddingLeft: `${entry.depth * 12}px`,
                          }
                }
            >
                <span className="block truncate">{label(entry.folder)}</span>
                {(query.trim() || prefix === "recent") && entry.path && (
                    <span className="block truncate text-xs text-muted-foreground">
                        {entry.path}
                    </span>
                )}
            </span>
            {assignedIds.has(entry.folder.id) && (
                <Check
                    className="ml-auto size-4"
                    aria-label={i18n("Already in this folder")}
                />
            )}
        </Command.Item>
    );
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                onKeyDown={(event) => {
                    if (["j", "k", "/"].includes(event.key))
                        event.stopPropagation();
                }}
                className="top-[15vh] max-h-[80dvh] -translate-y-0 overflow-y-auto gap-3 p-4 sm:max-w-md"
            >
                <DialogTitle>{i18n("Choose a folder")}</DialogTitle>
                <DialogDescription className="sr-only">
                    {i18n("Search by folder name or path.")}
                </DialogDescription>
                {creating ? (
                    <div className="space-y-3">
                        <p>
                            {i18n("Create folder “{name}”", {
                                name: query.trim(),
                            })}
                        </p>
                        <NativeSelect
                            aria-label={i18n("Parent folder")}
                            value={parentId}
                            onChange={(event) =>
                                setParentId(event.target.value)
                            }
                            className="w-full"
                        >
                            {parents.map((entry) => (
                                <option
                                    key={entry.folder.id}
                                    value={entry.folder.id}
                                >
                                    {joinFolderPath(
                                        entry.path,
                                        label(entry.folder),
                                    )}
                                </option>
                            ))}
                        </NativeSelect>
                        <div className="flex justify-end gap-2">
                            <Button
                                variant="outline"
                                onClick={() => setCreating(false)}
                            >
                                {i18n("Back")}
                            </Button>
                            <Button
                                disabled={!parentId || saving}
                                onClick={() => void create()}
                            >
                                {i18n("Create folder")}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <Command
                        shouldFilter={false}
                        label={i18n("Choose a folder")}
                    >
                        <Command.Input
                            autoFocus
                            value={query}
                            onValueChange={setQuery}
                            maxLength={100}
                            placeholder={i18n("Find a folder…")}
                            aria-label={i18n("Search folders")}
                            className="mb-2 w-full rounded border bg-background px-3 py-2 text-sm outline-none"
                        />
                        <Command.List className="max-h-[60vh] overflow-y-auto">
                            {query.trim() ? (
                                matches.map((entry) => row(entry, "match"))
                            ) : (
                                <>
                                    {recentFolders.some((folder) =>
                                        matches.some(
                                            (entry) =>
                                                entry.folder.id === folder.id,
                                        ),
                                    ) && (
                                        <Command.Group
                                            heading={i18n("Recently used")}
                                            className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground"
                                        >
                                            {recentFolders.flatMap((folder) => {
                                                const entry = matches.find(
                                                    (entry) =>
                                                        entry.folder.id ===
                                                        folder.id,
                                                );
                                                return entry
                                                    ? [row(entry, "recent")]
                                                    : [];
                                            })}
                                        </Command.Group>
                                    )}
                                    {(["personal", "org"] as const)
                                        .filter((group) =>
                                            matches.some(
                                                (entry) =>
                                                    entry.folder.scope ===
                                                    group,
                                            ),
                                        )
                                        .map((group) => (
                                            <Command.Group
                                                key={group}
                                                heading={
                                                    group === "org"
                                                        ? sharing
                                                            ? i18n(
                                                                  "Share with the Organization",
                                                              )
                                                            : i18n(
                                                                  "Organization",
                                                              )
                                                        : i18n("Private")
                                                }
                                                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground"
                                            >
                                                {matches
                                                    .filter(
                                                        (entry) =>
                                                            entry.folder
                                                                .scope ===
                                                            group,
                                                    )
                                                    .map((entry) =>
                                                        row(entry, group),
                                                    )}
                                            </Command.Group>
                                        ))}
                                </>
                            )}
                            {matches.length === 0 &&
                                query.trim() &&
                                parents.length > 0 && (
                                    <Command.Item
                                        value="create"
                                        className="flex items-center gap-2 rounded px-3 py-2 text-sm data-[selected=true]:bg-accent"
                                        onSelect={() => {
                                            setParentId(
                                                parents[0]?.folder.id ?? "",
                                            );
                                            setCreating(true);
                                        }}
                                    >
                                        <Plus className="size-4" />
                                        {i18n("Create folder “{name}”", {
                                            name: query.trim(),
                                        })}
                                    </Command.Item>
                                )}
                            {matches.length === 0 &&
                                (!query.trim() || parents.length === 0) && (
                                    <Command.Empty>
                                        {i18n("No folders match your search.")}
                                    </Command.Empty>
                                )}
                        </Command.List>
                    </Command>
                )}
            </DialogContent>
        </Dialog>
    );
}
