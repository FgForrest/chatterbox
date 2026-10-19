"use client";

import { useEffect } from "react";
import { useAppChrome } from "@/components/app-chrome-provider";

export function SettingsPageContent() {
    const { setSettingsOpen } = useAppChrome();
    useEffect(() => {
        setSettingsOpen(true);
        return () => setSettingsOpen(false);
    }, [setSettingsOpen]);
    return null;
}
