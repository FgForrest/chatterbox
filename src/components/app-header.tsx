"use client";

import { Search, Upload } from "lucide-react";
import { usePathname } from "next/navigation";
import { useExtracted } from "next-intl";
import type { ChangeEvent, RefObject } from "react";
import { useAppChrome } from "@/components/app-chrome-provider";
import { AppNav } from "@/components/app-nav";
import { AppUploadButton } from "@/components/app-upload-button";
import { UserMenu } from "@/components/dashboard/user-menu";
import { Button } from "@/components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { pageSearchScope } from "@/lib/search/types";

interface WorkstationUpload {
    isUploading: boolean;
    isProcessing: boolean;
    inputRef: RefObject<HTMLInputElement | null>;
    onTrigger: () => void;
    onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

/** Shared sticky header: sections, page search, upload and account actions. */
export function AppHeader({ upload }: { upload?: WorkstationUpload }) {
    const i18n = useExtracted();
    const chrome = useAppChrome();
    const scope = pageSearchScope(usePathname());
    const searchLabel =
        scope === "almanac"
            ? i18n("Search the Almanac")
            : scope === "tasks"
              ? i18n({ id: "appHeader_searchTasks", message: "Search tasks" })
              : i18n("Search Chatter");
    return (
        <TooltipProvider delayDuration={200}>
            <header className="sticky top-0 z-30 -mx-4 mb-6 flex items-center gap-2 border-b bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 lg:gap-3">
                <AppNav className="min-w-0" />
                <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                onClick={() => chrome.setPaletteOpen(true)}
                                variant="outline"
                                size="sm"
                                className="h-9 px-2 sm:px-3"
                                aria-label={searchLabel}
                            >
                                <Search className="size-4" aria-hidden="true" />
                                <span className="hidden lg:inline">
                                    {searchLabel}
                                </span>
                                <kbd className="ml-2 hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground xl:inline">
                                    {i18n("⌘K")}
                                </kbd>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                            {searchLabel}
                        </TooltipContent>
                    </Tooltip>
                    {upload ? (
                        <>
                            <input
                                ref={upload.inputRef}
                                type="file"
                                accept="audio/*,video/*,.mkv,.avi,.wmv,.m4v,.3gp,.ogv"
                                className="hidden"
                                onChange={upload.onChange}
                            />
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        ref={chrome.uploadButtonRef}
                                        onClick={upload.onTrigger}
                                        disabled={upload.isProcessing}
                                        variant="outline"
                                        size="sm"
                                        className="h-9 px-2 sm:px-3"
                                        aria-label={
                                            upload.isUploading
                                                ? i18n("Uploading")
                                                : i18n("Upload")
                                        }
                                    >
                                        <Upload
                                            className="size-4"
                                            aria-hidden="true"
                                        />
                                        <span className="hidden sm:inline">
                                            {upload.isUploading
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
                        </>
                    ) : (
                        <AppUploadButton buttonRef={chrome.uploadButtonRef} />
                    )}
                    <UserMenu
                        isAdmin={chrome.isAdmin}
                        userEmail={chrome.userEmail}
                        initialTheme={chrome.initialSettings.theme}
                        onOpenSettings={() => chrome.setSettingsOpen(true)}
                        onOpenShortcuts={() => chrome.setShortcutsOpen(true)}
                        onOpenOnboarding={() => {
                            chrome.setOnboardingInitialStep("welcome");
                            chrome.setOnboardingOpen(true);
                        }}
                        lastSyncTime={chrome.lastSyncTime}
                        nextSyncTime={chrome.nextSyncTime}
                        isAutoSyncing={chrome.isAutoSyncing}
                        lastSyncResult={chrome.lastSyncResult}
                        onSync={chrome.manualSync}
                    />
                </div>
            </header>
        </TooltipProvider>
    );
}
