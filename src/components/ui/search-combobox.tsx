"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { ChevronDown } from "lucide-react";
import { useExtracted } from "next-intl";
import {
    type CSSProperties,
    createContext,
    type ReactNode,
    type RefObject,
    useCallback,
    useContext,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { getPasswordManagerAttributes } from "@/lib/password-manager";
import { cn } from "@/lib/utils";

const PopupContainer = createContext<string[]>([]);

/** Shared searchable popup frame, including viewport placement and keyboard focus. */
export function Combobox({
    valueLabel,
    title,
    disabled = false,
    "aria-label": ariaLabel,
    variant = "field",
    className = "",
    children,
    open: controlledOpen,
    onOpenChange,
    anchorRef,
    actionTrigger,
    popupTitle,
}: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    anchorRef?: RefObject<HTMLButtonElement | null>;
    actionTrigger?: ReactNode;
    popupTitle?: string;
    valueLabel: ReactNode;
    title?: string;
    disabled?: boolean;
    "aria-label": string;
    variant?: "field" | "pill";
    className?: string;
    children: (props: {
        query: string;
        onQueryChange: (query: string) => void;
        close: () => void;
        listRef: (node: HTMLDivElement | null) => void;
    }) => ReactNode;
}) {
    const [internalOpen, setInternalOpen] = useState(false);
    const open = controlledOpen ?? internalOpen;
    const setOpen = useCallback(
        (value: boolean) => {
            setInternalOpen(value);
            onOpenChange?.(value);
        },
        [onOpenChange],
    );
    const parentPopups = useContext(PopupContainer);
    const [query, setQuery] = useState("");
    const [listId, setListId] = useState<string>();
    const [position, setPosition] = useState<CSSProperties>({});
    const trigger = useRef<HTMLButtonElement>(null);
    const popup = useRef<HTMLDivElement>(null);
    const popupId = useId();
    const popupContainers = useMemo(
        () => [...parentPopups, popupId],
        [parentPopups, popupId],
    );
    const containsPopup = useCallback(
        (target: Node) =>
            popup.current?.contains(target) ||
            (target instanceof Element &&
                target
                    .closest("[data-combobox-popup]")
                    ?.getAttribute("data-combobox-popup")
                    ?.split(" ")
                    .includes(popupId)),
        [popupId],
    );
    const expanded = open && !disabled;
    const listRef = useCallback((node: HTMLDivElement | null) => {
        if (node) setListId(node.id);
    }, []);
    const close = useCallback(() => {
        setOpen(false);
        setQuery("");
        (anchorRef?.current ?? trigger.current)?.focus({ preventScroll: true });
    }, [anchorRef, setOpen]);
    const show = (initialQuery = "") => {
        if (disabled) return;
        setQuery(initialQuery);
        setOpen(true);
    };

    useLayoutEffect(() => {
        if (!expanded) return;
        const update = () => {
            const rect = (
                anchorRef?.current ?? trigger.current
            )?.getBoundingClientRect();
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
        const anchor = anchorRef?.current ?? trigger.current;
        if (anchor) observer.observe(anchor);
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
    }, [expanded, anchorRef]);

    useEffect(() => {
        if (!expanded) return;
        const dismiss = (event: Event) => {
            const target = event.target;
            if (
                target instanceof Node &&
                popup.current &&
                !trigger.current?.contains(target) &&
                !anchorRef?.current?.contains(target) &&
                !containsPopup(target)
            ) {
                if (anchorRef && event.type === "pointerdown") close();
                else setOpen(false);
            }
        };
        document.addEventListener("pointerdown", dismiss, true);
        document.addEventListener("focusin", dismiss, true);
        return () => {
            document.removeEventListener("pointerdown", dismiss, true);
            document.removeEventListener("focusin", dismiss, true);
        };
    }, [expanded, anchorRef, close, setOpen, containsPopup]);

    return (
        <DialogPrimitive.Root
            modal={false}
            open={expanded}
            onOpenChange={setOpen}
        >
            {!anchorRef && (
                <DialogPrimitive.Trigger asChild>
                    <button
                        ref={trigger}
                        type="button"
                        role="combobox"
                        aria-label={ariaLabel}
                        aria-expanded={expanded}
                        aria-controls={expanded ? listId : undefined}
                        aria-haspopup="listbox"
                        disabled={disabled}
                        title={title}
                        className={cn(
                            variant === "pill" || actionTrigger
                                ? "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:text-foreground"
                                : "flex min-h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-left text-sm shadow-xs dark:bg-input/30 dark:hover:bg-input/50",
                            "outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
                            className,
                        )}
                        onClick={(event) => {
                            event.preventDefault();
                            if (expanded) close();
                            else show();
                        }}
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
                        {actionTrigger ?? valueLabel}
                        {!actionTrigger && (
                            <ChevronDown
                                className="size-4 shrink-0 text-muted-foreground opacity-50"
                                aria-hidden
                            />
                        )}
                    </button>
                </DialogPrimitive.Trigger>
            )}
            {expanded && (
                <DialogPrimitive.Portal>
                    <DialogPrimitive.Content
                        ref={popup}
                        data-combobox-popup={popupContainers.join(" ")}
                        role="presentation"
                        aria-describedby={undefined}
                        onEscapeKeyDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            close();
                        }}
                        onInteractOutside={(event) => {
                            if (
                                event.target instanceof Node &&
                                (anchorRef?.current?.contains(event.target) ||
                                    containsPopup(event.target))
                            )
                                event.preventDefault();
                        }}
                        onCloseAutoFocus={(event) => {
                            event.preventDefault();
                            if (
                                anchorRef ||
                                document.activeElement === document.body
                            )
                                (anchorRef?.current ?? trigger.current)?.focus({
                                    preventScroll: true,
                                });
                        }}
                        style={position}
                        className="z-50 flex flex-col overflow-y-auto overscroll-contain rounded-md border bg-popover p-2 text-popover-foreground shadow-md"
                    >
                        <DialogPrimitive.Title
                            className={
                                popupTitle
                                    ? "mb-2 px-1 text-xs font-medium text-muted-foreground"
                                    : "sr-only"
                            }
                        >
                            {popupTitle ?? ariaLabel}
                        </DialogPrimitive.Title>
                        <PopupContainer.Provider value={popupContainers}>
                            {children({
                                query,
                                onQueryChange: setQuery,
                                close,
                                listRef,
                            })}
                        </PopupContainer.Provider>
                    </DialogPrimitive.Content>
                </DialogPrimitive.Portal>
            )}
        </DialogPrimitive.Root>
    );
}

export interface ComboboxOption {
    value: string;
    label: string;
    description?: ReactNode;
    disabled?: boolean;
    group?: string;
    alwaysVisible?: boolean;
}

/** Ordered options filtered by their labels with the folder combobox's shared popup. */
export function SearchCombobox({
    options,
    value,
    onValueChange,
    "aria-label": label,
    placeholder,
    disabled,
}: {
    options: ComboboxOption[];
    value: string;
    onValueChange: (value: string) => void;
    "aria-label": string;
    placeholder?: string;
    disabled?: boolean;
}) {
    const i18n = useExtracted();
    const selected = options.find((option) => option.value === value);
    const [active, setActive] = useState("");
    return (
        <Combobox
            aria-label={label}
            valueLabel={selected?.label ?? placeholder ?? label}
            disabled={disabled}
        >
            {({ query, onQueryChange, close, listRef }) => {
                const matches = options.filter(
                    (option) =>
                        option.alwaysVisible ||
                        option.label
                            .toLocaleLowerCase()
                            .includes(query.trim().toLocaleLowerCase()),
                );
                return (
                    <Command
                        shouldFilter={false}
                        value={
                            matches.some(
                                (option) =>
                                    `option:${option.value}` === active &&
                                    !option.disabled,
                            )
                                ? active
                                : `option:${(query.trim() ? matches.find((option) => !option.alwaysVisible && !option.disabled) : matches.find((option) => !option.disabled))?.value ?? ""}`
                        }
                        onValueChange={setActive}
                        label={label}
                        className="flex min-h-0 flex-col"
                        onKeyDown={(event) => {
                            if (event.key === "Escape") {
                                event.preventDefault();
                                event.stopPropagation();
                                close();
                            }
                            if (event.key === "Tab") close();
                        }}
                    >
                        <Command.Input
                            asChild
                            {...getPasswordManagerAttributes()}
                            autoFocus
                            value={query}
                            onValueChange={(query) => {
                                onQueryChange(query);
                                setActive("");
                            }}
                            aria-label={label}
                            placeholder={i18n("Search…")}
                            className="mb-2 w-full shrink-0 rounded border bg-background px-3 py-2 text-sm"
                        >
                            <input type="search" />
                        </Command.Input>
                        <Command.List
                            ref={listRef}
                            className="min-h-0 max-h-[60vh] overflow-y-auto overscroll-contain"
                        >
                            {!matches.length && (
                                <Command.Empty className="px-3 py-2 text-sm text-muted-foreground">
                                    {i18n("No results")}
                                </Command.Empty>
                            )}
                            {matches.map((option, index) => (
                                <div key={option.value}>
                                    {option.group &&
                                        option.group !==
                                            matches[index - 1]?.group && (
                                            <p className="px-3 py-2 text-xs text-muted-foreground">
                                                {option.group}
                                            </p>
                                        )}
                                    <Command.Item
                                        value={`option:${option.value}`}
                                        disabled={option.disabled}
                                        onSelect={() => {
                                            close();
                                            onValueChange(option.value);
                                        }}
                                        className="cursor-default rounded px-3 py-2 text-sm data-[selected=true]:bg-accent data-[disabled=true]:opacity-50"
                                    >
                                        <span className="block">
                                            {option.label}
                                        </span>
                                        {option.description && (
                                            <span className="block text-xs text-muted-foreground">
                                                {option.description}
                                            </span>
                                        )}
                                    </Command.Item>
                                </div>
                            ))}
                        </Command.List>
                    </Command>
                );
            }}
        </Combobox>
    );
}
