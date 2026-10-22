"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    buildSettingsNav,
    SETTINGS_STORAGE_KEY,
} from "@/components/settings-nav-config";
import { getAppHistoryState } from "@/lib/history-state";
import type { SettingsSection } from "@/types/settings";

/**
 * Owns nav state for the settings dialog: which section is active,
 * which row is keyboard-highlighted, plus the URL-hash <-> localStorage
 * sync and the arrow-key / enter / escape handler.
 *
 * Lifted out of SettingsDialog so the dialog itself can focus on
 * layout/composition. The hook is "always on" -- it adds a window
 * keydown listener whenever `open` is true, mirroring the original
 * component's behavior exactly.
 */
export function useSettingsNav(
    open: boolean,
    onClose: () => void,
    isHosted: boolean,
    mailEnabled = false,
    accessManagement = false,
    isOrgAccount = false,
) {
    const settingsNav = useMemo(
        () =>
            buildSettingsNav({
                isHosted,
                isOrgAccount,
                mailEnabled,
                accessManagement,
            }),
        [isHosted, isOrgAccount, mailEnabled, accessManagement],
    );
    const [activeSection, setActiveSection] = useState<SettingsSection>(() => {
        if (typeof window === "undefined") return "providers";
        const requested =
            new URLSearchParams(window.location.search).get("section") ||
            window.location.hash.slice(1);
        return (
            settingsNav.find((item) => item.id === requested)?.id ??
            settingsNav.find(
                (item) =>
                    item.id === localStorage.getItem(SETTINGS_STORAGE_KEY),
            )?.id ??
            settingsNav[0].id
        );
    });
    const [keyboardSelectedIndex, setKeyboardSelectedIndex] = useState(0);
    const lastLocationRef = useRef<{ section: string; hash: string } | null>(
        null,
    );
    const visibleActiveSection = settingsNav.some(
        (item) => item.id === activeSection,
    )
        ? activeSection
        : settingsNav[0].id;
    const selectSection = useCallback(
        (section: SettingsSection) => {
            if (settingsNav.some((item) => item.id === section))
                setActiveSection(section);
        },
        [settingsNav],
    );

    // Initial section resolution: prefer URL hash, fall back to
    // localStorage. Re-runs on hashchange so in-app hash writes (e.g.
    // the grace-state banner "Export my data" button) navigate the
    // settings dialog without a full reload.
    useEffect(() => {
        if (!open || typeof window === "undefined") return;

        const applyHash = (): boolean => {
            const hash = window.location.hash.slice(1);
            const validSection = settingsNav.find(
                (item) => item.id === hash,
            )?.id;
            if (!validSection) return false;
            setActiveSection(validSection);
            setKeyboardSelectedIndex(
                settingsNav.findIndex((item) => item.id === validSection),
            );
            return true;
        };

        const section = new URLSearchParams(window.location.search).get(
            "section",
        );
        const requested = settingsNav.find((item) => item.id === section)?.id;
        const changedHash =
            lastLocationRef.current?.section === section &&
            lastLocationRef.current.hash !== window.location.hash;
        if (requested && !changedHash) {
            setActiveSection(requested);
        } else if (!applyHash()) {
            const lastSection = localStorage.getItem(SETTINGS_STORAGE_KEY);
            if (lastSection) {
                const validLastSection = settingsNav.find(
                    (item) => item.id === lastSection,
                )?.id;
                if (validLastSection) {
                    setActiveSection(validLastSection);
                    setKeyboardSelectedIndex(
                        settingsNav.findIndex(
                            (item) => item.id === validLastSection,
                        ),
                    );
                }
            }
        }

        const onHashChange = () => {
            applyHash();
        };
        window.addEventListener("hashchange", onHashChange);
        return () => window.removeEventListener("hashchange", onHashChange);
    }, [settingsNav, open]);

    // Persist active section to URL hash + localStorage so deep links
    // round-trip and reopening the dialog lands on the last-visited
    // section.
    useEffect(() => {
        if (!open || typeof window === "undefined") return;
        const url = new URL(window.location.href);
        url.hash = visibleActiveSection;
        url.searchParams.set("section", visibleActiveSection);
        window.history.replaceState(getAppHistoryState(), "", url);
        lastLocationRef.current = {
            section: visibleActiveSection,
            hash: url.hash,
        };
        localStorage.setItem(SETTINGS_STORAGE_KEY, visibleActiveSection);
    }, [visibleActiveSection, open]);

    // Focus the first nav button when the dialog opens. Small delay
    // gives Radix's focus-trap a chance to settle so our focus call
    // doesn't get clobbered.
    useEffect(() => {
        if (!open) return;
        const timer = setTimeout(() => {
            const firstButton = document.querySelector(
                '[data-settings-nav="first"]',
            ) as HTMLButtonElement | null;
            firstButton?.focus();
        }, 100);
        return () => clearTimeout(timer);
    }, [open]);

    // Sync the keyboard cursor with the active section whenever the
    // user clicks a different row (so arrow-key nav picks up where
    // the click left off, not where the keyboard cursor used to be).
    useEffect(() => {
        const index = settingsNav.findIndex(
            (item) => item.id === visibleActiveSection,
        );
        if (index !== -1) {
            setKeyboardSelectedIndex(index);
        }
    }, [visibleActiveSection, settingsNav]);

    const handleKeyDown = useCallback(
        (e: KeyboardEvent) => {
            if (!open || e.defaultPrevented) return;

            if (e.key === "Escape") {
                onClose();
                return;
            }

            // Don't hijack arrow keys when the user is typing in a
            // form field somewhere inside the settings pane.
            const target = e.target as HTMLElement;
            if (
                target.tagName === "INPUT" ||
                target.tagName === "TEXTAREA" ||
                target.isContentEditable
            ) {
                return;
            }

            switch (e.key) {
                case "ArrowDown": {
                    e.preventDefault();
                    setKeyboardSelectedIndex((prev) =>
                        Math.min(prev + 1, settingsNav.length - 1),
                    );
                    break;
                }
                case "ArrowUp": {
                    e.preventDefault();
                    setKeyboardSelectedIndex((prev) => Math.max(prev - 1, 0));
                    break;
                }
                case "Enter":
                case " ": {
                    e.preventDefault();
                    const selectedItem = settingsNav[keyboardSelectedIndex];
                    if (selectedItem) {
                        setActiveSection(selectedItem.id);
                    }
                    break;
                }
            }
        },
        [open, keyboardSelectedIndex, onClose, settingsNav],
    );

    useEffect(() => {
        if (!open) return;
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [open, handleKeyDown]);

    return {
        activeSection: visibleActiveSection,
        setActiveSection: selectSection,
        keyboardSelectedIndex,
    };
}
