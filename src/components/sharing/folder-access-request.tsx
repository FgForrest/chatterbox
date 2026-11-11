"use client";

import { FolderLock } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { HelpLink } from "@/components/help/help-button";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useDashboardRefresh } from "@/hooks/use-dashboard-refresh";
import type { RecordingFolder } from "@/types/folder";
import {
    FolderRequestError,
    useRestrictedFolderRequest,
} from "./restricted-folder-api";
import { useRestrictedFolders } from "./restricted-folder-context";

/** A request action shared by the public folder screen and its tree menu. */
export function FolderAccessRequest({
    folder,
    menu = false,
}: {
    folder: RecordingFolder;
    menu?: boolean;
}) {
    const i18n = useExtracted();
    const { writable } = useRestrictedFolders();
    const request = useRestrictedFolderRequest();
    const refresh = useDashboardRefresh();
    const [state, setState] = useState(folder.accessRequest ?? "none");
    const [busy, setBusy] = useState(false);
    useEffect(
        () => setState(folder.accessRequest ?? "none"),
        [folder.accessRequest],
    );
    const pending = state === "pending";
    const changeRequest = async () => {
        if (busy || !writable) return;
        const previous = state;
        setState(pending ? "none" : "pending");
        setBusy(true);
        try {
            await request(
                `/api/folders/${encodeURIComponent(folder.id)}/access-requests`,
                pending ? "DELETE" : "POST",
            );
            refresh();
        } catch (error) {
            setState(previous);
            if (
                error instanceof FolderRequestError &&
                (error.status === 403 || error.status === 409)
            )
                refresh();
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Could not update folder. Please try again."),
            );
        } finally {
            setBusy(false);
        }
    };
    const label = pending ? i18n("Cancel request") : i18n("Request access");
    if (menu)
        return writable ? (
            <DropdownMenuItem
                disabled={busy}
                onSelect={(event) => {
                    event.preventDefault();
                    void changeRequest();
                }}
            >
                {label}
            </DropdownMenuItem>
        ) : null;
    return (
        <div className="flex flex-col gap-3">
            <output className="text-sm text-muted-foreground">
                {pending
                    ? i18n(
                          "Request sent. Anyone in the audience can approve it.",
                      )
                    : state === "declined"
                      ? i18n("Your request was declined. You can ask again.")
                      : null}
            </output>
            {writable && (
                <Button
                    variant={pending ? "outline" : "default"}
                    disabled={busy}
                    onClick={() => void changeRequest()}
                >
                    {label}
                </Button>
            )}
        </div>
    );
}

/** Public-node-only empty state. It never requests items or audience metadata. */
export function FolderNoAccess({
    folder,
    onBack,
}: {
    folder: RecordingFolder;
    onBack?: () => void;
}) {
    const i18n = useExtracted();
    const names = folder.managers
        ?.flatMap((manager) => (manager.name ? [manager.name] : []))
        .join(", ");
    return (
        <section className="flex min-h-72 flex-col items-center justify-center gap-4 rounded-lg border p-8 text-center">
            <FolderLock className="size-10 text-restricted" aria-hidden />
            <h2 className="flex items-center gap-2 text-lg font-semibold">
                {folder.name}
                <HelpLink
                    topic="folders.restricted"
                    label={i18n("restricted folders")}
                />
            </h2>
            <p className="text-sm text-muted-foreground">
                {i18n("Only its audience and curators can see this folder.")}
            </p>
            {names && (
                <p className="text-sm text-muted-foreground">
                    {i18n("Audience managers: {names}", { names })}
                </p>
            )}
            <FolderAccessRequest folder={folder} />
            {onBack && (
                <Button variant="ghost" onClick={onBack}>
                    {i18n("Back to Recent")}
                </Button>
            )}
        </section>
    );
}
