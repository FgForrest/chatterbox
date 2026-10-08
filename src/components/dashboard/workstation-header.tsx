"use client";

import { Command, Upload } from "lucide-react";
import { useExtracted } from "next-intl";
import { AppHeader } from "@/components/app-header";
import { AppNav } from "@/components/app-nav";
import { UserMenu } from "@/components/dashboard/user-menu";
import { Button } from "@/components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";

interface Props {
    isAdmin: boolean;
    userEmail: string | null;
    initialTheme: "light" | "dark" | "system";
    lastSyncTime: Date | null;
    nextSyncTime: Date | null;
    isAutoSyncing: boolean;
    lastSyncResult: {
        success: boolean;
        newRecordings?: number;
        error?: string;
    } | null;
    onSync: () => void;
    isUploading: boolean;
    isProcessing: boolean;
    uploadInputRef: React.RefObject<HTMLInputElement | null>;
    onTriggerUpload: () => void;
    onUploadInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onOpenPalette: () => void;
    onOpenSettings: () => void;
    onOpenShortcuts: () => void;
}

/**
 * Sticky page header for the dashboard workstation.
 *
 * Title left, actions right, always one row. On mobile the buttons
 * collapse to icon-only (per-button `sm:` overrides) so the whole bar
 * fits in ~360px. `min-w-0` on the title block lets it truncate before
 * pushing buttons off-screen.
 *
 * Search, upload, and account actions stay visible. Manual sync and help
 * are available from the account menu.
 */
export function WorkstationHeader({
    isAdmin,
    userEmail,
    initialTheme,
    lastSyncTime,
    nextSyncTime,
    isAutoSyncing,
    lastSyncResult,
    onSync,
    isUploading,
    isProcessing,
    uploadInputRef,
    onTriggerUpload,
    onUploadInputChange,
    onOpenPalette,
    onOpenSettings,
    onOpenShortcuts,
}: Props) {
    const i18n = useExtracted();
    return (
        <AppHeader>
            <div className="flex min-w-0 items-center gap-3">
                {/*
                  The section nav doubles as the page title: "Recordings" is
                  the current section and reads exactly as the heading it
                  replaced.

                  Recording count lives in the list pane's own meta row
                  ("N of N recordings") -- showing it again in the page
                  header is duplicative on every breakpoint, so the
                  count is gone here.
                */}
                <AppNav className="min-w-0" />
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            onClick={onOpenPalette}
                            variant="outline"
                            size="sm"
                            className="h-9"
                            aria-label={i18n("Open command palette")}
                        >
                            <Command className="size-4 sm:mr-2" />
                            <span className="hidden sm:inline">
                                {i18n("Search")}
                            </span>
                            <kbd className="ml-2 hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground lg:inline">
                                {i18n("⌘K")}
                            </kbd>
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                        {i18n("Search recordings, transcripts, and actions")}
                    </TooltipContent>
                </Tooltip>
                <input
                    ref={uploadInputRef}
                    type="file"
                    accept="audio/*,video/*,.mkv,.avi,.wmv,.m4v,.3gp,.ogv"
                    className="hidden"
                    onChange={onUploadInputChange}
                />
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            onClick={onTriggerUpload}
                            disabled={isProcessing}
                            variant="outline"
                            size="sm"
                            className="h-9"
                            aria-label={
                                isUploading ? i18n("Uploading") : i18n("Upload")
                            }
                        >
                            <Upload className="size-4 sm:mr-2" />
                            <span className="hidden sm:inline">
                                {isUploading
                                    ? i18n("Uploading…")
                                    : i18n("Upload")}
                            </span>
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                        {i18n(
                            "Upload an audio or video file from your computer",
                        )}
                    </TooltipContent>
                </Tooltip>
                <UserMenu
                    isAdmin={isAdmin}
                    initialTheme={initialTheme}
                    userEmail={userEmail}
                    onOpenSettings={onOpenSettings}
                    onOpenShortcuts={onOpenShortcuts}
                    lastSyncTime={lastSyncTime}
                    nextSyncTime={nextSyncTime}
                    isAutoSyncing={isAutoSyncing}
                    lastSyncResult={lastSyncResult}
                    onSync={onSync}
                />
            </div>
        </AppHeader>
    );
}
