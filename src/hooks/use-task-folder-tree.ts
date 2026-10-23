"use client";

import { useCallback, useEffect, useState } from "react";
import { useOrgEvents } from "@/hooks/use-org-events";
import type { FolderOrganization, RecordingFolder } from "@/types/folder";

/** Keep task filing choices current across navigation and Organization tree changes. */
export function useTaskFolderTree(enabled = true): RecordingFolder[] {
    const [folders, setFolders] = useState<RecordingFolder[]>([]);
    const load = useCallback(() => {
        if (!enabled) return;
        void fetch("/api/folders")
            .then((response) => (response.ok ? response.json() : null))
            .then((body: FolderOrganization | null) => {
                if (body) setFolders(body.folders);
            })
            .catch(() => {});
    }, [enabled]);
    useEffect(() => {
        load();
        window.addEventListener("focus", load);
        return () => window.removeEventListener("focus", load);
    }, [load]);
    useOrgEvents(enabled, load);
    return folders;
}
