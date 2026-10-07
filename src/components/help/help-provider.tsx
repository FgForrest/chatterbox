"use client";

import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";
import {
    type HelpTarget,
    type HelpTopic,
    helpTarget,
    topicForLocation,
} from "@/lib/help/topics";
import { HelpDrawer } from "./help-drawer";

interface HelpContextValue {
    /** Open the guide at `topic`, or at the chapter about the current screen. */
    openHelp: (topic?: HelpTopic) => void;
}

const HelpContext = createContext<HelpContextValue | null>(null);

function isTyping(target: EventTarget | null): boolean {
    return (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT" ||
            target.isContentEditable)
    );
}

/** Holds the help drawer for the signed-in app; `h` opens it anywhere. */
export function HelpProvider({ children }: { children: ReactNode }) {
    const [target, setTarget] = useState<HelpTarget | null>(null);

    const openHelp = useCallback((topic?: HelpTopic) => {
        setTarget(helpTarget(topic ?? topicForLocation(window.location)));
    }, []);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "h" || event.repeat) return;
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            if (isTyping(event.target)) return;
            event.preventDefault();
            openHelp();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [openHelp]);

    const value = useMemo(() => ({ openHelp }), [openHelp]);

    return (
        <HelpContext.Provider value={value}>
            {children}
            <HelpDrawer target={target} onClose={() => setTarget(null)} />
        </HelpContext.Provider>
    );
}

/** `openHelp` from the nearest `HelpProvider`; a no-op outside one. */
export function useHelp(): HelpContextValue {
    return useContext(HelpContext) ?? { openHelp: () => {} };
}
