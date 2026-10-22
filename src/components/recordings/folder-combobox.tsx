"use client";

import { ChevronDown, Users } from "lucide-react";
import { useExtracted } from "next-intl";
import {
    type CSSProperties,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import {
    type FolderSearchEntry,
    FolderSearchList,
} from "@/components/recordings/folder-search-list";
import { useFolderLabel } from "@/hooks/use-folder-label";
import { useLibraryPreferences } from "@/hooks/use-library-preferences";
import { joinFolderPath } from "@/lib/folders/navigation";

interface FolderComboboxProps {
    entries: FolderSearchEntry[];
    value: string;
    onValueChange: (folderId: string) => void;
    onCreate?: (query: string) => void;
    disabled?: boolean;
    "aria-label"?: string;
}

/** Inline folder choice with the same search and recent folders as FolderPicker. */
export function FolderCombobox({
    entries,
    value,
    onValueChange,
    onCreate,
    disabled = false,
    "aria-label": ariaLabel,
}: FolderComboboxProps) {
    const i18n = useExtracted();
    const label = useFolderLabel();
    const { rememberFolder } = useLibraryPreferences();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [listId, setListId] = useState<string>();
    const [position, setPosition] = useState<CSSProperties>({});
    const trigger = useRef<HTMLButtonElement>(null);
    const popup = useRef<HTMLDivElement>(null);
    const expanded = open && !disabled;
    const selected = entries.find((entry) => entry.folder.id === value);
    const selectedPath = selected
        ? joinFolderPath(selected.path, label(selected.folder))
        : undefined;
    const listRef = useCallback((node: HTMLDivElement | null) => {
        if (node) setListId(node.id);
    }, []);
    const close = () => {
        setOpen(false);
        trigger.current?.focus({ preventScroll: true });
    };
    const show = (initialQuery = "") => {
        if (disabled) return;
        setQuery(initialQuery);
        setOpen(true);
    };

    useLayoutEffect(() => {
        if (!expanded) return;
        const update = () => {
            const rect = trigger.current?.getBoundingClientRect();
            if (!rect) return;
            const viewport = window.visualViewport;
            const viewportTop = viewport?.offsetTop ?? 0;
            const viewportLeft = viewport?.offsetLeft ?? 0;
            const viewportHeight = viewport?.height ?? window.innerHeight;
            const viewportWidth = viewport?.width ?? window.innerWidth;
            const viewportBottom = viewportTop + viewportHeight;
            const belowTop = Math.max(rect.bottom + 4, viewportTop + 8);
            const aboveBottom = Math.min(rect.top - 4, viewportBottom - 8);
            const below = viewportBottom - belowTop - 8;
            const above = aboveBottom - viewportTop - 8;
            const upward = below < 280 && above > below;
            const width = Math.min(
                Math.max(rect.width, 280),
                viewportWidth - 16,
            );
            const maxHeight = Math.min(
                384,
                Math.max(0, upward ? above : below),
            );
            const next: CSSProperties = {
                position: "fixed",
                left: Math.max(
                    viewportLeft + 8,
                    Math.min(
                        rect.left,
                        viewportLeft + viewportWidth - width - 8,
                    ),
                ),
                width,
                maxHeight,
                top: upward ? aboveBottom : belowTop,
                transform: upward ? "translateY(-100%)" : undefined,
            };
            setPosition((previous) =>
                previous.left === next.left &&
                previous.top === next.top &&
                previous.transform === next.transform &&
                previous.width === next.width &&
                previous.maxHeight === next.maxHeight
                    ? previous
                    : next,
            );
        };
        let frame: number | undefined;
        const scheduleUpdate = (event?: Event) => {
            if (
                event?.target instanceof Node &&
                popup.current?.contains(event.target)
            )
                return;
            if (frame !== undefined) return;
            frame = requestAnimationFrame(() => {
                frame = undefined;
                update();
            });
        };
        update();
        const observer = new ResizeObserver(() => scheduleUpdate());
        if (trigger.current) observer.observe(trigger.current);
        const viewport = window.visualViewport;
        window.addEventListener("resize", scheduleUpdate);
        window.addEventListener("scroll", scheduleUpdate, true);
        viewport?.addEventListener("resize", scheduleUpdate);
        viewport?.addEventListener("scroll", scheduleUpdate);
        return () => {
            observer.disconnect();
            if (frame !== undefined) cancelAnimationFrame(frame);
            window.removeEventListener("resize", scheduleUpdate);
            window.removeEventListener("scroll", scheduleUpdate, true);
            viewport?.removeEventListener("resize", scheduleUpdate);
            viewport?.removeEventListener("scroll", scheduleUpdate);
        };
    }, [expanded]);

    useEffect(() => {
        if (!expanded) return;
        const dismiss = (event: Event) => {
            const target = event.target;
            if (
                target instanceof Node &&
                !trigger.current?.contains(target) &&
                !popup.current?.contains(target)
            )
                setOpen(false);
        };
        document.addEventListener("pointerdown", dismiss, true);
        document.addEventListener("focusin", dismiss);
        return () => {
            document.removeEventListener("pointerdown", dismiss, true);
            document.removeEventListener("focusin", dismiss);
        };
    }, [expanded]);

    return (
        <>
            <button
                ref={trigger}
                type="button"
                role="combobox"
                aria-label={ariaLabel ?? i18n("Folder")}
                aria-expanded={expanded}
                aria-controls={expanded ? listId : undefined}
                aria-haspopup="listbox"
                disabled={disabled}
                title={selectedPath}
                className="flex min-h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-left text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50"
                onClick={() => (expanded ? close() : show())}
                onKeyDown={(event) => {
                    if (
                        event.key === "ArrowDown" ||
                        event.key === "ArrowUp" ||
                        event.key === "Enter" ||
                        event.key === " "
                    ) {
                        event.preventDefault();
                        event.stopPropagation();
                        show();
                    } else if (
                        event.key.length === 1 &&
                        !event.ctrlKey &&
                        !event.metaKey &&
                        !event.altKey
                    ) {
                        event.preventDefault();
                        event.stopPropagation();
                        show(event.key);
                    }
                }}
            >
                {selected?.folder.scope === "org" && (
                    <Users
                        className="size-4 shrink-0 text-organization"
                        aria-hidden
                    />
                )}
                <span
                    className={`min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere] ${selected ? "" : "text-muted-foreground"}`}
                >
                    {selectedPath ?? i18n("Choose a folder")}
                </span>
                <ChevronDown
                    className="size-4 shrink-0 text-muted-foreground opacity-50"
                    aria-hidden
                />
            </button>
            {expanded &&
                createPortal(
                    <div
                        ref={popup}
                        style={position}
                        className="z-50 flex flex-col rounded-md border bg-popover p-2 text-popover-foreground shadow-md"
                    >
                        <FolderSearchList
                            entries={entries}
                            query={query}
                            onQueryChange={setQuery}
                            showPaths
                            listRef={listRef}
                            onEscape={close}
                            onTab={close}
                            onSelect={(folderId) => {
                                rememberFolder(folderId);
                                close();
                                onValueChange(folderId);
                            }}
                            onCreate={
                                onCreate
                                    ? (query) => {
                                          close();
                                          onCreate(query);
                                      }
                                    : undefined
                            }
                        />
                    </div>,
                    document.body,
                )}
        </>
    );
}
