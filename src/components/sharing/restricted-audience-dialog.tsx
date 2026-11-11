"use client";

import { useExtracted } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { HelpLink } from "@/components/help/help-button";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { useDashboardRefresh } from "@/hooks/use-dashboard-refresh";
import type { RecordingFolder } from "@/types/folder";
import {
    type AudiencePerson,
    RestrictedAudiencePicker,
} from "./restricted-audience-picker";
import {
    FolderRequestError,
    useRestrictedFolderRequest,
} from "./restricted-folder-api";
import { useRestrictedFolders } from "./restricted-folder-context";

interface Member {
    userId: string;
    name: string | null;
    email: string;
    role: "manager" | "member";
    ownsItems: boolean;
}
interface Audience {
    members: Member[];
    role: "manager" | "member" | "curator";
}
interface AccessRequest {
    id: string;
    userId: string;
    name: string | null;
    email: string;
    state: "pending";
}

/** Audience membership and access decisions share one body for all entry points. */
export function RestrictedAudienceDialog({
    folder,
    onOpenChange,
}: {
    folder: RecordingFolder;
    onOpenChange: (open: boolean) => void;
}) {
    const i18n = useExtracted();
    const { writable, userId } = useRestrictedFolders();
    const request = useRestrictedFolderRequest();
    const refresh = useDashboardRefresh();
    const [audience, setAudience] = useState<Audience | null>(null);
    const [requests, setRequests] = useState<AccessRequest[]>([]);
    const [selected, setSelected] = useState<AudiencePerson[]>([]);
    const [busy, setBusy] = useState(false);
    const [removing, setRemoving] = useState<Member | null>(null);
    const [error, setError] = useState<string | null>(null);
    const base = `/api/folders/${encodeURIComponent(folder.id)}`;
    const load = useCallback(async () => {
        const [data, pending] = await Promise.allSettled([
            request<Audience>(`${base}/audience`),
            writable
                ? request<{ requests: AccessRequest[] }>(
                      `${base}/access-requests`,
                  )
                : Promise.resolve({ requests: [] as AccessRequest[] }),
        ]);
        if (data.status === "fulfilled") setAudience(data.value);
        if (pending.status === "fulfilled") setRequests(pending.value.requests);
        if (data.status === "rejected") throw data.reason;
        if (pending.status === "rejected") throw pending.reason;
        setError(null);
    }, [base, request, writable]);
    useEffect(() => {
        if (folder.access !== false)
            void load().catch((error) => setError(String(error)));
    }, [folder.access, load]);
    if (folder.access === false) return null;
    const act = async (optimistic: () => void, write: () => Promise<void>) => {
        if (busy || !writable) return;
        const previousAudience = audience;
        const previousRequests = requests;
        let written = false;
        optimistic();
        setBusy(true);
        try {
            await write();
            written = true;
            await load().catch((error: unknown) => {
                if (
                    error instanceof FolderRequestError &&
                    error.code === "RESTRICTED_FOLDER_NO_ACCESS"
                ) {
                    onOpenChange(false);
                    return;
                }
                throw error;
            });
            refresh();
        } catch (error) {
            if (!written) {
                setAudience(previousAudience);
                setRequests(previousRequests);
            }
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Could not update folder. Please try again."),
            );
            if (
                error instanceof FolderRequestError &&
                (error.status === 409 || error.status === 403)
            ) {
                await load().catch(() => {});
                refresh();
            }
        } finally {
            setBusy(false);
        }
    };
    const canRemove = writable && audience?.role !== "member";
    const remove = (member: Member) => {
        if (!audience || !canRemove) return;
        void act(
            () =>
                setAudience({
                    ...audience,
                    members: audience.members.filter(
                        (entry) => entry.userId !== member.userId,
                    ),
                }),
            async () => {
                await request(`${base}/audience`, "DELETE", {
                    userId: member.userId,
                });
            },
        );
    };
    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        {i18n("Who can see it")}
                        <HelpLink
                            topic="folders.restricted"
                            label={i18n("restricted folders")}
                        />
                    </DialogTitle>
                    <DialogDescription>{folder.name}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    {error && <p role="alert">{error}</p>}
                    {!audience && !error && <output>{i18n("Loading…")}</output>}
                    {audience?.members.map((member) => (
                        <div
                            key={member.userId}
                            className="flex items-center justify-between gap-3 rounded border p-2"
                        >
                            <div>
                                <p>
                                    {member.userId === userId
                                        ? i18n("{name} (you)", {
                                              name: member.name ?? member.email,
                                          })
                                        : (member.name ?? member.email)}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {member.role === "manager"
                                        ? i18n("Audience manager")
                                        : i18n("Audience member")}
                                    {member.ownsItems &&
                                        ` · ${i18n("has items here")}`}
                                </p>
                            </div>
                            {canRemove && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() =>
                                        member.ownsItems
                                            ? setRemoving(member)
                                            : remove(member)
                                    }
                                >
                                    {i18n("Remove")}
                                </Button>
                            )}
                        </div>
                    ))}
                    {writable && audience && (
                        <>
                            <RestrictedAudiencePicker
                                selected={selected}
                                onChange={setSelected}
                                disabled={busy}
                                excludedUserIds={audience.members.map(
                                    (member) => member.userId,
                                )}
                            />
                            <Button
                                disabled={busy || !selected.length}
                                onClick={() =>
                                    void act(
                                        () =>
                                            setAudience({
                                                ...audience,
                                                members: [
                                                    ...audience.members,
                                                    ...selected.map(
                                                        (person) => ({
                                                            userId: person.id,
                                                            name: person.name,
                                                            email: person.email,
                                                            role: "member" as const,
                                                            ownsItems: false,
                                                        }),
                                                    ),
                                                ],
                                            }),
                                        async () => {
                                            const result = await request<{
                                                skippedUserIds: string[];
                                            }>(`${base}/audience`, "POST", {
                                                userIds: selected.map(
                                                    (person) => person.id,
                                                ),
                                            });
                                            const names = selected
                                                .filter((person) =>
                                                    result.skippedUserIds?.includes(
                                                        person.id,
                                                    ),
                                                )
                                                .map(
                                                    (person) =>
                                                        person.name ??
                                                        person.email,
                                                )
                                                .join(", ");
                                            if (names)
                                                toast.error(
                                                    i18n(
                                                        "{names} could not be added",
                                                        { names },
                                                    ),
                                                );
                                            setSelected([]);
                                        },
                                    )
                                }
                            >
                                {i18n("Add people")}
                            </Button>
                        </>
                    )}
                    <h3 className="font-medium">
                        {i18n("Waiting for approval")}
                    </h3>
                    {!requests.length && (
                        <p className="text-sm text-muted-foreground">
                            {i18n("No pending requests.")}
                        </p>
                    )}
                    {requests.map((entry) => (
                        <div
                            key={entry.id}
                            className="flex flex-wrap items-center gap-2 rounded border p-2"
                        >
                            <span className="mr-auto">
                                {entry.name ?? entry.email}
                            </span>
                            {writable &&
                                (["approved", "declined"] as const).map(
                                    (state) => (
                                        <Button
                                            key={state}
                                            size="sm"
                                            variant="outline"
                                            disabled={busy}
                                            onClick={() =>
                                                void act(
                                                    () =>
                                                        setRequests(
                                                            requests.filter(
                                                                (row) =>
                                                                    row.id !==
                                                                    entry.id,
                                                            ),
                                                        ),
                                                    async () => {
                                                        await request(
                                                            `${base}/access-requests/${encodeURIComponent(entry.id)}`,
                                                            "PATCH",
                                                            { state },
                                                        );
                                                    },
                                                )
                                            }
                                        >
                                            {state === "approved"
                                                ? i18n("Approve")
                                                : i18n("Decline")}
                                        </Button>
                                    ),
                                )}
                        </div>
                    ))}
                </div>
                <AlertDialog
                    open={removing !== null}
                    onOpenChange={(open) => {
                        if (!open) setRemoving(null);
                    }}
                >
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>
                                {i18n("Remove from audience?")}
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                                {i18n(
                                    "{name} has items in this folder. They stay here and the audience keeps seeing them; {name} keeps them as owner and can still take them out.",
                                    {
                                        name:
                                            removing?.name ??
                                            removing?.email ??
                                            "",
                                    },
                                )}
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>
                                {i18n("Cancel")}
                            </AlertDialogCancel>
                            <AlertDialogAction
                                disabled={busy || !canRemove}
                                onClick={() => {
                                    if (removing) remove(removing);
                                    setRemoving(null);
                                }}
                            >
                                {i18n("Remove")}
                            </AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </DialogContent>
        </Dialog>
    );
}
