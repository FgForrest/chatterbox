"use client";

import { useExtracted } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { useRestrictedFolderRequest } from "@/components/sharing/restricted-folder-api";
import { useRestrictedFolders } from "@/components/sharing/restricted-folder-context";
import type { ItemReaders } from "@/components/sharing/restricted-item-audience";
import { Button } from "@/components/ui/button";
import type { FolderOrganization, RecordingFolder } from "@/types/folder";

export interface RestrictedTaskAssignment {
    person: { personId: string; name: string };
    email: string | null;
    folder: RecordingFolder;
}

/** Check only when the assignee changes, using authorized readers and placements. */
export async function restrictedTaskAssignment(
    itemId: string,
    person: { personId: string; name: string },
): Promise<RestrictedTaskAssignment | null> {
    const [readerResponse, personResponse, folderResponse] = await Promise.all([
        fetch(`/api/items/${encodeURIComponent(itemId)}/readers`),
        fetch(`/api/people/${encodeURIComponent(person.personId)}`),
        fetch("/api/folders"),
    ]);
    if (!readerResponse.ok || !personResponse.ok || !folderResponse.ok)
        return null;
    const [readers, detail, tree] = await Promise.all([
        readerResponse.json() as Promise<ItemReaders>,
        personResponse.json() as Promise<{
            person: { primaryEmail: string | null };
        }>,
        folderResponse.json() as Promise<FolderOrganization>,
    ]);
    if (!readers.restricted || readers.organization) return null;
    const email = detail.person.primaryEmail;
    if (
        email &&
        readers.readers.some(
            (reader) => reader.email.toLowerCase() === email.toLowerCase(),
        )
    )
        return null;
    const folder = tree.folders.find(
        (folder) =>
            (folder.restricted || folder.restricting) &&
            folder.access !== false &&
            tree.assignments.some(
                (entry) =>
                    entry.recordingId === itemId &&
                    entry.folderId === folder.id,
            ),
    );
    return folder ? { person, email, folder } : null;
}

/** Inline decision before saving an assignee who cannot read the restricted item. */
export function RestrictedTaskWarning({
    assignment,
    onAssign,
    onCancel,
}: {
    assignment: RestrictedTaskAssignment;
    onAssign: () => void;
    onCancel?: () => void;
}) {
    const i18n = useExtracted();
    const { writable } = useRestrictedFolders();
    const request = useRestrictedFolderRequest();
    const [busy, setBusy] = useState(false);
    const canAdd =
        writable && !!assignment.folder.restrictedRole && !!assignment.email;
    return (
        <div
            className="flex flex-wrap items-center gap-2 rounded border border-restricted/30 bg-restricted/5 p-3 text-xs"
            role="alert"
        >
            <p className="basis-full">
                {i18n(
                    "{name} cannot see the folder {folder}, so they will not see this task.",
                    {
                        name: assignment.person.name,
                        folder: assignment.folder.name,
                    },
                )}
            </p>
            {canAdd && (
                <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={async () => {
                        setBusy(true);
                        try {
                            const response = await fetch(
                                `/api/shares/people?q=${encodeURIComponent(assignment.email ?? "")}`,
                            );
                            if (!response.ok)
                                throw new Error(
                                    i18n("Could not find colleagues"),
                                );
                            const data = (await response.json()) as {
                                people: { id: string; email: string }[];
                            };
                            const person = data.people.find(
                                (person) =>
                                    person.email.toLowerCase() ===
                                    assignment.email?.toLowerCase(),
                            );
                            if (!person)
                                throw new Error(
                                    i18n(
                                        "This person could not be added to the audience.",
                                    ),
                                );
                            const result = await request<{
                                skippedUserIds: string[];
                            }>(
                                `/api/folders/${encodeURIComponent(assignment.folder.id)}/audience`,
                                "POST",
                                { userIds: [person.id] },
                            );
                            if (result.skippedUserIds?.includes(person.id))
                                throw new Error(
                                    i18n("{names} could not be added", {
                                        names: assignment.person.name,
                                    }),
                                );
                            onAssign();
                        } catch (error) {
                            toast.error(
                                error instanceof Error
                                    ? error.message
                                    : i18n(
                                          "Could not update folder. Please try again.",
                                      ),
                            );
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    {i18n("Add to the audience")}
                </Button>
            )}
            <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={onAssign}
            >
                {i18n("Assign anyway")}
            </Button>
            {onCancel && (
                <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={onCancel}
                >
                    {i18n("Cancel")}
                </Button>
            )}
        </div>
    );
}
