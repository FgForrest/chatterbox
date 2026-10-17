"use client";

import { FolderPlus, MessagesSquare, RefreshCw, Upload } from "lucide-react";
import { useExtracted } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Props {
    isSyncing: boolean;
    onSync: () => void;
    onUpload: () => void;
    onNewFolder: () => void;
    hasFilingFolder: boolean;
    compact?: boolean;
}

/**
 * Shown when the user has no recordings yet (and no in-flight upload).
 * Keeps folder creation, device sync, and file upload reachable.
 */
export function WorkstationEmptyState({
    isSyncing,
    onSync,
    onUpload,
    onNewFolder,
    hasFilingFolder,
    compact = false,
}: Props) {
    const i18n = useExtracted();
    const needsFolder = !hasFilingFolder;
    const content = (
        <div
            className={cn(
                "flex flex-col items-center justify-center text-center",
                compact ? "py-6" : "py-16",
            )}
        >
            <MessagesSquare className="mb-4 size-16 text-muted-foreground" />
            <h3 className="mb-2 text-lg font-semibold">
                {needsFolder
                    ? i18n("Start with a folder")
                    : i18n("No recordings yet.")}
            </h3>
            {needsFolder ? (
                <p className="mb-6 max-w-md text-center text-sm text-muted-foreground">
                    {i18n(
                        "Create a folder first. Then sync your device or upload a recording.",
                    )}
                </p>
            ) : null}
            <div className="flex flex-wrap justify-center gap-2">
                {needsFolder ? (
                    <Button onClick={onNewFolder}>
                        <FolderPlus className="mr-2 size-4" />
                        {i18n("New folder")}
                    </Button>
                ) : null}
                <Button variant="outline" onClick={onSync} disabled={isSyncing}>
                    {isSyncing ? (
                        <>
                            <RefreshCw className="mr-2 size-4 animate-spin" />{" "}
                            {i18n("Syncing…")}
                        </>
                    ) : (
                        <>
                            <RefreshCw className="mr-2 size-4" />{" "}
                            {i18n("Sync Device")}
                        </>
                    )}
                </Button>
                <Button variant="outline" onClick={onUpload}>
                    <Upload className="mr-2 size-4" /> {i18n("Upload")}
                </Button>
            </div>
        </div>
    );
    if (compact) return content;
    return (
        <Card>
            <CardContent>{content}</CardContent>
        </Card>
    );
}
