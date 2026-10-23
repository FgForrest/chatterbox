"use client";

import { Command } from "cmdk";
import { Check, Plus, Users } from "lucide-react";
import { useExtracted } from "next-intl";
import {
    type ComponentProps,
    type Ref,
    useCallback,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { SharedFolderIcon } from "@/components/sharing/shared-folder-icon";

import { useFolderLabel } from "@/hooks/use-folder-label";
import { useLibraryPreferences } from "@/hooks/use-library-preferences";
import type { LabelledFolder } from "@/lib/folders/labels";
import { type FolderMatch, matchFolderEntries } from "@/lib/folders/navigation";

export type FolderSearchEntry = FolderMatch<LabelledFolder & { id: string }>;

interface FolderSearchListProps {
    entries: FolderSearchEntry[];
    query: string;
    onQueryChange: (query: string) => void;
    onSelect: (folderId: string) => void;
    assignedIds?: ReadonlySet<string>;
    disabled?: boolean;
    sharing?: boolean;
    showPaths?: boolean;
    onCreate?: (query: string) => void;
    createLabel?: string;
    createOnlyWhenEmpty?: boolean;
    onEscape?: () => void;
    onTab?: () => void;
    listRef?: Ref<HTMLDivElement>;
}

function FolderResults(props: ComponentProps<"div">) {
    return <div {...props} />;
}

function folderIdOf(value: string): string {
    return value.slice(value.indexOf(":") + 1);
}

/** Shared keyboard-searchable folder results for dialogs and inline forms. */
export function FolderSearchList({
    entries,
    query,
    onQueryChange,
    onSelect,
    assignedIds,
    disabled = false,
    sharing = false,
    showPaths = false,
    onCreate,
    createLabel,
    createOnlyWhenEmpty = false,
    onEscape,
    onTab,
    listRef,
}: FolderSearchListProps) {
    const i18n = useExtracted();
    const label = useFolderLabel();
    const { recentFolders } = useLibraryPreferences();
    const [active, setActive] = useState("");
    const [activeId, setActiveId] = useState<string>();
    const command = useRef<HTMLDivElement>(null);
    const matches = useMemo(
        () => matchFolderEntries(entries, query, label),
        [entries, query, label],
    );
    const searching = Boolean(query.trim());
    const groups = useMemo(() => {
        if (searching) return [{ prefix: "match", entries: matches }];
        const byId = new Map(matches.map((entry) => [entry.folder.id, entry]));
        return [
            {
                prefix: "recent",
                entries: recentFolders.flatMap((folder) => {
                    const entry = byId.get(folder.id);
                    return entry ? [entry] : [];
                }),
            },
            ...(["personal", "org"] as const).map((scope) => ({
                prefix: scope,
                entries: matches.filter(
                    (entry) => entry.folder.scope === scope,
                ),
            })),
        ].filter((group) => group.entries.length > 0);
    }, [matches, searching, recentFolders]);
    const offerCreate = Boolean(
        onCreate &&
            (!createOnlyWhenEmpty || (searching && matches.length === 0)),
    );
    const values = useMemo(() => {
        const result = groups.flatMap(({ prefix, entries }) =>
            entries
                .filter((entry) => !assignedIds?.has(entry.folder.id))
                .map((entry) => `${prefix}:${entry.folder.id}`),
        );
        if (offerCreate) result.push("create");
        return result;
    }, [groups, assignedIds, offerCreate]);
    const activeValue = values.includes(active)
        ? active
        : (values.find(
              (value) =>
                  active !== "create" &&
                  folderIdOf(value) === folderIdOf(active),
          ) ??
          values[0] ??
          "");
    const optionNodes = useRef(new Map<string, HTMLElement>());
    useLayoutEffect(() => {
        const available = new Set(values);
        optionNodes.current = new Map(
            Array.from(
                command.current?.querySelectorAll<HTMLElement>("[cmdk-item]") ??
                    [],
            )
                .filter((node) => available.has(node.dataset.value ?? ""))
                .map((node) => [node.dataset.value ?? "", node]),
        );
    }, [values]);
    useLayoutEffect(() => {
        setActive(activeValue);
        setActiveId(
            values.includes(activeValue)
                ? optionNodes.current.get(activeValue)?.id
                : undefined,
        );
    }, [activeValue, values]);
    const select = useCallback(
        (value: string) => {
            if (value === "create") onCreate?.(query);
            else onSelect(folderIdOf(value));
        },
        [onSelect, onCreate, query],
    );
    const recentHeading = i18n("Recently used");
    const personalHeading = i18n("Private");
    const organizationHeading = sharing
        ? i18n("Share with the Organization")
        : i18n("Organization");
    const assignedLabel = i18n("Already in this folder");
    const rows = useMemo(() => {
        const groupHeading = (prefix: string) => {
            if (prefix === "recent") return recentHeading;
            if (prefix === "org") return organizationHeading;
            return personalHeading;
        };
        return groups.map(({ prefix, entries }) => {
            const items = entries.map((entry) => {
                const name = label(entry.folder);
                const showPath = searching || prefix === "recent" || showPaths;
                return (
                    <Command.Item
                        forceMount
                        key={`${prefix}:${entry.folder.id}`}
                        value={`${prefix}:${entry.folder.id}`}
                        aria-label={
                            showPath && entry.path
                                ? `${name} ${entry.path}`
                                : name
                        }
                        disabled={assignedIds?.has(entry.folder.id) || disabled}
                        onSelect={select}
                        className="flex cursor-default items-center gap-2 rounded px-3 py-2 text-sm data-[selected=true]:bg-accent data-[disabled=true]:opacity-50"
                    >
                        {entry.folder.scope === "org" ? (
                            <Users
                                className="size-4 shrink-0 text-organization"
                                aria-hidden
                            />
                        ) : (
                            <SharedFolderIcon folder={entry.folder} />
                        )}
                        <span
                            className="min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere]"
                            style={
                                showPath
                                    ? undefined
                                    : {
                                          paddingLeft: `${Math.min(entry.depth, 5) * 12}px`,
                                      }
                            }
                        >
                            <span className="block">{name}</span>
                            {showPath && entry.path && (
                                <span className="block text-xs text-muted-foreground">
                                    {entry.path}
                                </span>
                            )}
                        </span>
                        {assignedIds?.has(entry.folder.id) && (
                            <Check
                                className="ml-auto size-4 shrink-0"
                                aria-label={assignedLabel}
                            />
                        )}
                    </Command.Item>
                );
            });
            return prefix === "match" ? (
                items
            ) : (
                <Command.Group
                    key={prefix}
                    heading={groupHeading(prefix)}
                    className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                    {items}
                </Command.Group>
            );
        });
    }, [
        groups,
        label,
        searching,
        showPaths,
        assignedIds,
        disabled,
        select,
        assignedLabel,
        recentHeading,
        organizationHeading,
        personalHeading,
    ]);
    return (
        <Command
            ref={command}
            shouldFilter={false}
            value={activeValue}
            onValueChange={setActive}
            label={i18n("Choose a folder")}
            className="flex min-h-0 flex-col"
            onKeyDown={(event) => {
                if (event.key === "Tab") onTab?.();
                if (
                    ["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(
                        event.key,
                    ) ||
                    (event.ctrlKey && ["n", "j", "p", "k"].includes(event.key))
                ) {
                    event.stopPropagation();
                    if (disabled) event.preventDefault();
                }
                if (event.key === "Escape" && onEscape) {
                    event.stopPropagation();
                    event.preventDefault();
                    onEscape();
                }
            }}
        >
            <Command.Input
                asChild
                autoFocus
                value={query}
                onValueChange={onQueryChange}
                maxLength={100}
                placeholder={i18n("Find a folder…")}
                aria-label={i18n("Search folders")}
                className="mb-2 w-full shrink-0 rounded border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                <input aria-activedescendant={activeId} />
            </Command.Input>
            <Command.List
                asChild
                ref={listRef}
                className="min-h-0 max-h-[60vh] overflow-y-auto overscroll-contain"
            >
                <FolderResults aria-activedescendant={activeId}>
                    {rows}
                    {matches.length === 0 && !offerCreate && (
                        <Command.Empty className="px-3 py-2 text-sm text-muted-foreground">
                            {i18n("No folders match your search.")}
                        </Command.Empty>
                    )}
                    {offerCreate && (
                        <Command.Item
                            forceMount
                            value="create"
                            disabled={disabled}
                            onSelect={select}
                            className="flex items-center gap-2 rounded px-3 py-2 text-sm data-[selected=true]:bg-accent data-[disabled=true]:opacity-50"
                        >
                            <Plus className="size-4 shrink-0" aria-hidden />
                            {createLabel ?? i18n("New folder…")}
                        </Command.Item>
                    )}
                </FolderResults>
            </Command.List>
        </Command>
    );
}
