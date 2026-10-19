"use client";

import { useEffect } from "react";

interface ShortcutHandlers {
    onNext: () => void;
    onPrev: () => void;
    onFocusSearch: () => void;
    onOpenPalette: () => void;
    onOpenShortcuts: () => void;
    onOpenSettings: () => void;
    /** When false, j/k/Enter/etc. are ignored (e.g. a modal is open). */
    enabled?: boolean;
    globalShortcuts?: boolean;
}

function isInputTarget(el: EventTarget | null) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
    if (el.isContentEditable) return true;
    return false;
}

/**
 * Dashboard-wide keyboard shortcuts. Mounted once at the top of
 * Workstation. The player owns its own Space/← /→/↑/↓ handlers; we
 * deliberately don't overlap them here.
 */
export function useListKeyboardNav({
    onNext,
    onPrev,
    onFocusSearch,
    onOpenPalette,
    onOpenShortcuts,
    onOpenSettings,
    enabled = true,
    globalShortcuts = true,
}: ShortcutHandlers) {
    useEffect(() => {
        if (!enabled) return;
        const handler = (e: KeyboardEvent) => {
            // ⌘K / Ctrl+K always opens the palette, even when an input
            // has focus — matches Linear / Raycast convention.
            if (
                globalShortcuts &&
                (e.metaKey || e.ctrlKey) &&
                e.key.toLowerCase() === "k"
            ) {
                e.preventDefault();
                onOpenPalette();
                return;
            }

            if (isInputTarget(e.target)) return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;

            switch (e.key) {
                case "j":
                    e.preventDefault();
                    onNext();
                    break;
                case "k":
                    e.preventDefault();
                    onPrev();
                    break;
                case "/":
                    e.preventDefault();
                    onFocusSearch();
                    break;
                case "?":
                    if (!globalShortcuts) break;
                    e.preventDefault();
                    onOpenShortcuts();
                    break;
                case ",":
                    if (!globalShortcuts) break;
                    e.preventDefault();
                    onOpenSettings();
                    break;
            }
        };

        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [
        enabled,
        globalShortcuts,
        onNext,
        onPrev,
        onFocusSearch,
        onOpenPalette,
        onOpenShortcuts,
        onOpenSettings,
    ]);
}
