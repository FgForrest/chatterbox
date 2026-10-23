"use client";

import {
    FolderInput,
    FolderOutput,
    Inbox,
    Link,
    Lock,
    UserPlus,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
} from "react";
import { toast } from "sonner";
import { ArrivalNotice } from "@/components/dashboard/arrival-notice";
import { FolderPicker } from "@/components/recordings/folder-picker";
import {
    changeFolderShareRequest,
    ReceivedFolderDialog,
} from "@/components/sharing/folder-sharing";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { getApiErrorMessage } from "@/lib/api-errors";
import { subscribeEvents } from "@/lib/events/client";
import type { listMyFolderInvitations } from "@/lib/sharing/folder-shares";
import type {
    listItemShares,
    listMyInvitations,
} from "@/lib/sharing/person-shares";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

type Share = Awaited<ReturnType<typeof listItemShares>>[number];
export type Invitation =
    | Awaited<ReturnType<typeof listMyInvitations>>[number]
    | Awaited<ReturnType<typeof listMyFolderInvitations>>[number];
const SharingContext = createContext(false);
const SharingRefreshContext = createContext<() => void>(() => {});

/** Enable person sharing and bind its mutations to the dashboard refresh. */
export function PersonSharingProvider({
    value,
    children,
}: {
    value: boolean;
    children: ReactNode;
}) {
    const { refresh } = useRouter();
    return (
        <SharingContext.Provider value={value}>
            <SharingRefreshContext.Provider value={refresh}>
                {children}
            </SharingRefreshContext.Provider>
        </SharingContext.Provider>
    );
}

/** Whether this viewer may use person sharing on this deployment. */
export function usePersonSharing() {
    return useContext(SharingContext);
}

/** Refresh the sharing surface after a receiver changes their filing or access. */
export function usePersonSharingRefresh() {
    return useContext(SharingRefreshContext);
}

export async function changeShare(
    id: string,
    version: number,
    action: string,
    folderId?: string,
) {
    const response = await fetch(`/api/shares/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, version, folderId }),
    });
    if (!response.ok)
        throw new Error(
            await getApiErrorMessage(response, "Could not update sharing"),
        );
}

/** One owner sharing body for recordings, mail and folders, in dialogs or settings. */
export function PersonShareDialog({
    itemId,
    title,
    kind,
    open,
    onOpenChange,
    onChanged,
    allowInvite = true,
    inline = false,
}: {
    itemId: string;
    title: string;
    kind: "audio" | "mail" | "folder";
    inline?: boolean;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onChanged?: (shares: Share[]) => void;
    allowInvite?: boolean;
}) {
    const i18n = useExtracted();
    const refreshSharing = usePersonSharingRefresh();
    const endpoint =
        kind === "folder"
            ? `/api/folders/${encodeURIComponent(itemId)}/shares`
            : `/api/items/${encodeURIComponent(itemId)}/shares`;
    const [shares, setShares] = useState<Share[]>([]);
    const [query, setQuery] = useState("");
    const [people, setPeople] = useState<
        { id: string; name: string | null; email: string }[]
    >([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const load = useCallback(async () => {
        const response = await fetch(endpoint);
        if (!response.ok)
            throw new Error(
                await getApiErrorMessage(
                    response,
                    i18n("Could not load sharing"),
                ),
            );
        const data = (await response.json()) as { shares: Share[] };
        setShares(data.shares);
        onChanged?.(data.shares);
    }, [endpoint, i18n, onChanged]);
    useEffect(() => {
        if (!open) return;
        const reload = () => {
            void load().catch((error) => setError(String(error)));
        };
        reload();
        return subscribeEvents((event) => {
            if (event.type === "share") reload();
        });
    }, [open, load]);
    useEffect(() => {
        if (!open || query.trim().length < 2) {
            setPeople([]);
            return;
        }
        const abort = new AbortController();
        const timer = setTimeout(() => {
            void fetch(`/api/shares/people?q=${encodeURIComponent(query)}`, {
                signal: abort.signal,
            })
                .then(async (response) => {
                    if (!response.ok)
                        throw new Error(
                            await getApiErrorMessage(
                                response,
                                i18n("Could not find colleagues"),
                            ),
                        );
                    return response.json() as Promise<{
                        people: typeof people;
                    }>;
                })
                .then((data) => setPeople(data.people))
                .catch((error) => {
                    if (!abort.signal.aborted) setError(String(error));
                });
        }, 250);
        return () => {
            clearTimeout(timer);
            abort.abort();
        };
    }, [query, open, i18n]);
    const act = async (action: () => Promise<void>) => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            await action();
            await load();
            refreshSharing();
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : i18n("Could not update sharing"),
            );
        } finally {
            setBusy(false);
        }
    };
    const invite = async (receiverId: string) => {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ receiverIds: [receiverId] }),
        });
        if (!response.ok)
            throw new Error(
                await getApiErrorMessage(
                    response,
                    i18n("Could not update sharing"),
                ),
            );
        setQuery("");
    };
    const content = (
        <>
            <h3 className="flex items-center gap-2">
                <UserPlus className="size-5 text-person-share" />
                {kind === "folder"
                    ? i18n("Share folder")
                    : kind === "mail"
                      ? i18n("Share email")
                      : i18n("Share recording")}
            </h3>
            <p className="text-sm text-muted-foreground">{title}</p>
            {allowInvite && (
                <Input
                    aria-label={i18n("Colleague's name or email")}
                    placeholder={i18n("Colleague's name or email")}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                />
            )}
            {(allowInvite ? people : [])
                .filter(
                    (person) =>
                        !shares.some(
                            (share) =>
                                share.receiverUserId === person.id &&
                                (share.state === "accepted" ||
                                    share.state === "pending"),
                        ),
                )
                .map((person) => (
                    <div
                        key={person.id}
                        className="flex items-center justify-between gap-2 rounded border p-2"
                    >
                        <div>
                            {person.name ?? person.email}
                            <div className="text-xs text-muted-foreground">
                                {person.email}
                            </div>
                        </div>
                        <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => void act(() => invite(person.id))}
                        >
                            {i18n("Add")}
                        </Button>
                    </div>
                ))}
            <p className="text-sm font-medium">{i18n("Shared with")}</p>
            <div className="max-h-72 space-y-2 overflow-auto">
                {shares.map((share) => (
                    <div
                        key={share.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded border p-2"
                    >
                        <div>
                            {share.name ?? share.email}
                            <div className="text-xs text-muted-foreground">
                                {share.email}
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-xs">
                                {share.state === "pending"
                                    ? i18n("Waiting for acceptance")
                                    : share.state === "accepted"
                                      ? i18n("Accepted")
                                      : share.state === "declined"
                                        ? i18n("Declined")
                                        : i18n("Removed")}
                            </span>
                            {(allowInvite ||
                                share.state === "pending" ||
                                share.state === "accepted") && (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={busy}
                                    onClick={() =>
                                        void act(() =>
                                            share.state === "pending" ||
                                            share.state === "accepted"
                                                ? (kind === "folder"
                                                      ? changeFolderShareRequest
                                                      : changeShare)(
                                                      share.id,
                                                      share.version,
                                                      share.state === "pending"
                                                          ? "cancel"
                                                          : "remove",
                                                  )
                                                : invite(share.receiverUserId),
                                        )
                                    }
                                >
                                    {share.state === "pending"
                                        ? i18n("Cancel")
                                        : share.state === "accepted"
                                          ? i18n("Remove")
                                          : i18n("Invite again")}
                                </Button>
                            )}
                        </div>
                    </div>
                ))}
            </div>
            {kind === "folder" && (
                <p className="rounded bg-person-share/10 p-3 text-sm">
                    {i18n(
                        "Only items directly in this folder are shared, never subfolders. Items you add later become visible to recipients. Items you remove stop being visible.",
                    )}
                </p>
            )}
            <p className="flex gap-2 rounded bg-person-share/10 p-3 text-sm">
                <Lock className="size-4 shrink-0 text-person-share" />
                {kind === "folder"
                    ? i18n(
                          "The folder and its items stay yours and private. The Organization will not see them.",
                      )
                    : allowInvite
                      ? i18n(
                            "This stays your private item. The Organization will not see it. Recipients can read it and complete tasks assigned to them.",
                        )
                      : i18n(
                            "The Organization already sees this item. Existing person shares and their filing stay in place.",
                        )}
            </p>
            <p className="text-xs text-muted-foreground">
                {i18n("Everyone must accept their invitation.")}
            </p>
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            )}
            {!inline && (
                <Button className="ml-auto" onClick={() => onOpenChange(false)}>
                    {i18n("Done")}
                </Button>
            )}
        </>
    );
    if (inline) return <div className="space-y-3">{content}</div>;
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xl">
                <DialogTitle className="sr-only">
                    {kind === "folder"
                        ? i18n("Share folder")
                        : kind === "mail"
                          ? i18n("Share email")
                          : i18n("Share recording")}
                </DialogTitle>
                <DialogDescription className="sr-only">
                    {title}
                </DialogDescription>
                {content}
            </DialogContent>
        </Dialog>
    );
}

/** Owner share action and copy-link explanation, using the same receiver list. */
export function OwnerSharingActions({
    itemId,
    title,
    kind,
    copyLink,
    shared,
    children,
    open,
    onOpenChange,
    onCountChange,
}: {
    itemId: string;
    title: string;
    kind: "audio" | "mail";
    copyLink: () => Promise<void>;
    shared: boolean;
    children?: ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCountChange: (count: number) => void;
}) {
    const i18n = useExtracted();
    const dialogOpen = open;
    const setDialogOpen = onOpenChange;
    const [popoverOpen, setPopoverOpen] = useState(false);
    const [shares, setShares] = useState<Share[]>([]);
    const load = useCallback(async () => {
        const response = await fetch(
            `/api/items/${encodeURIComponent(itemId)}/shares`,
        );
        if (response.ok)
            setShares(((await response.json()) as { shares: Share[] }).shares);
    }, [itemId]);
    useEffect(() => {
        void load().catch(() => {});
    }, [load]);
    const active = shares.filter(
        (share) => share.state === "pending" || share.state === "accepted",
    );
    useEffect(() => {
        onCountChange(active.length);
    }, [active.length, onCountChange]);
    useEffect(
        () =>
            subscribeEvents((event) => {
                if (event.type === "share") void load().catch(() => {});
            }),
        [load],
    );
    return (
        <>
            {shared && shares.length > 0 && active.length === 0 && (
                <Button
                    variant="ghost"
                    size="sm"
                    className="text-person-share"
                    onClick={() => setDialogOpen(true)}
                >
                    <FolderOutput className="size-4" />
                    {i18n("Manage sharing")}
                </Button>
            )}
            {!shared && (
                <Button
                    variant="outline"
                    size="sm"
                    className="text-person-share"
                    onClick={() => setDialogOpen(true)}
                >
                    <UserPlus className="size-4" />
                    {i18n("Share")}
                </Button>
            )}
            {shared ? (
                children
            ) : (
                <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
                    <PopoverTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={i18n("Copy link")}
                            onClick={() => void load()}
                        >
                            <Link className="size-4" />
                        </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-80 space-y-3">
                        <p className="font-medium">
                            {active.length
                                ? i18n(
                                      "Only you and {count, plural, one {# person} other {# people}} can open this link",
                                      { count: active.length },
                                  )
                                : i18n("Only you can open this link")}
                        </p>
                        {active.length ? (
                            <ul className="text-sm">
                                {active.map((share) => (
                                    <li key={share.id}>
                                        {share.name ?? share.email}
                                        {share.state === "pending"
                                            ? ` (${i18n("Waiting for acceptance")})`
                                            : ""}
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-sm text-muted-foreground">
                                {i18n(
                                    "Share the item first so a colleague can open the link.",
                                )}
                            </p>
                        )}
                        <div className="flex justify-end gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                    setPopoverOpen(false);
                                    setDialogOpen(true);
                                }}
                            >
                                {active.length
                                    ? i18n("Manage sharing")
                                    : i18n("Share…")}
                            </Button>
                            <Button
                                size="sm"
                                onClick={() => {
                                    void copyLink();
                                    setPopoverOpen(false);
                                }}
                            >
                                {active.length
                                    ? i18n("Copy link")
                                    : i18n("Copy anyway")}
                            </Button>
                        </div>
                    </PopoverContent>
                </Popover>
            )}
            <PersonShareDialog
                itemId={itemId}
                title={title}
                kind={kind}
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                onChanged={setShares}
                allowInvite={!shared}
            />
        </>
    );
}

/** Invitation count, waiting list, folder acceptance and arrival notice. */
export function PersonInvitations({
    initialInvitations,
    folders,
    notifications = true,
}: {
    initialInvitations: Invitation[];
    folders: RecordingFolder[];
    notifications?: boolean;
}) {
    const enabled = usePersonSharing();
    const i18n = useExtracted();
    const { refresh } = useRouter();
    const [invitations, setInvitations] = useState(initialInvitations);
    const [open, setOpen] = useState(false);
    useEffect(() => {
        if (
            notifications &&
            new URLSearchParams(window.location.search).get("invitations") ===
                "1"
        )
            setOpen(true);
    }, [notifications]);
    const [filing, setFiling] = useState<Invitation | null>(null);
    const known = useRef(new Set(initialInvitations.map((item) => item.id)));
    useEffect(() => {
        setInvitations(initialInvitations);
    }, [initialInvitations]);
    useEffect(() => {
        if (!enabled) return;
        return subscribeEvents((event) => {
            if (event.type !== "share") return;
            void fetch("/api/shares")
                .then(async (response) => {
                    if (!response.ok) return;
                    const data = (await response.json()) as {
                        invitations: Invitation[];
                    };
                    const latest = data.invitations
                        .filter((item) => !known.current.has(item.id))
                        .at(-1);
                    known.current = new Set(
                        data.invitations.map((item) => item.id),
                    );
                    setInvitations(data.invitations);
                    if (latest && notifications)
                        toast.custom(
                            () => (
                                <ArrivalNotice
                                    recording={{
                                        id: latest.itemId,
                                        kind:
                                            latest.kind === "folder"
                                                ? "audio"
                                                : latest.kind,
                                        filename: latest.title,
                                        startTime: String(latest.invitedAt),
                                        duration: 0,
                                        filesize: 0,
                                        deviceSn: "",
                                        ownerName: latest.ownerName,
                                    }}
                                    invitation
                                    folderInvitation={latest.kind === "folder"}
                                    more={data.invitations.length - 1}
                                    dateTimeFormat="relative"
                                    onOpen={() => {
                                        setOpen(true);
                                        toast.dismiss("share-invitation");
                                    }}
                                    onClose={() =>
                                        toast.dismiss("share-invitation")
                                    }
                                />
                            ),
                            { id: "share-invitation", duration: Infinity },
                        );
                    if (notifications) refresh();
                })
                .catch(() => {});
        });
    }, [enabled, refresh, notifications]);
    const respond = async (
        invitation: Invitation,
        action: "accept" | "decline",
        folderId?: string,
    ) => {
        const previous = invitations;
        setInvitations((items) =>
            items.filter((item) => item.id !== invitation.id),
        );
        try {
            if (invitation.kind === "folder")
                await changeFolderShareRequest(
                    invitation.id,
                    invitation.version,
                    action,
                );
            else
                await changeShare(
                    invitation.id,
                    invitation.version,
                    action,
                    folderId,
                );
            setFiling(null);
            refresh();
        } catch (error) {
            setInvitations(previous);
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Could not update sharing"),
            );
            throw error;
        }
    };
    if (!enabled) return null;
    return (
        <>
            <Button
                variant="ghost"
                className="w-full justify-start gap-2 text-person-share"
                aria-label={i18n("Invitations ({count})", {
                    count: String(invitations.length),
                })}
                onClick={() => setOpen(true)}
            >
                <Inbox className="size-4" />
                <span>{i18n("Invitations")}</span>
                <span className="ml-auto rounded-full bg-person-share px-2 text-xs text-white">
                    {invitations.length}
                </span>
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent>
                    <DialogTitle>{i18n("Invitations")}</DialogTitle>
                    <DialogDescription>
                        {i18n(
                            "Accept an invitation and file the item into your private folders.",
                        )}
                    </DialogDescription>
                    {invitations.map((invitation) => (
                        <div
                            key={invitation.id}
                            className="space-y-2 rounded border p-3"
                        >
                            <p>{invitation.title}</p>
                            <p className="text-sm text-person-share">
                                {i18n("Shared by {owner}", {
                                    owner: invitation.ownerName,
                                })}
                            </p>
                            <div className="flex gap-2">
                                <Button
                                    size="sm"
                                    onClick={() => {
                                        setFiling(invitation);
                                        setOpen(false);
                                    }}
                                >
                                    {invitation.kind === "folder"
                                        ? i18n("Accept and attach…")
                                        : i18n("Accept and file…")}
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                        void respond(
                                            invitation,
                                            "decline",
                                        ).catch(() => {})
                                    }
                                >
                                    {i18n("Decline")}
                                </Button>
                            </div>
                        </div>
                    ))}
                </DialogContent>
            </Dialog>
            {filing?.kind === "folder" && (
                <ReceivedFolderDialog
                    key={filing.id}
                    shareId={filing.id}
                    version={filing.version}
                    name={filing.title}
                    ownerName={filing.ownerName}
                    action="accept"
                    folders={folders}
                    open
                    onOpenChange={(open) => {
                        if (!open) setFiling(null);
                    }}
                    onSaved={() => {
                        setInvitations((items) =>
                            items.filter((item) => item.id !== filing.id),
                        );
                        setFiling(null);
                    }}
                />
            )}
            {filing && filing.kind !== "folder" && (
                <FolderPicker
                    folders={folders}
                    assignedIds={new Set()}
                    open
                    onOpenChange={(open) => {
                        if (!open) setFiling(null);
                    }}
                    scope="personal"
                    title={
                        filing.kind === "mail"
                            ? i18n("Where should this email go?")
                            : i18n("Where should this recording go?")
                    }
                    onSelect={(folderId) => respond(filing, "accept", folderId)}
                />
            )}
        </>
    );
}

/** The receiver's sole editable item property: filing in their own private tree. */
export function ReceivedItemBanner({
    recording,
    folders,
    shared = false,
}: {
    recording: Recording;
    folders: RecordingFolder[];
    shared?: boolean;
}) {
    const i18n = useExtracted();
    const { refresh } = useRouter();
    const [filing, setFiling] = useState(false);
    return (
        <div className="space-y-2">
            <p className="rounded-lg border border-person-share/30 bg-person-share/10 p-3 text-sm">
                {shared
                    ? i18n(
                          "{owner} shares this item with you. The Organization can also see it. You can read it and complete tasks assigned to you.",
                          { owner: recording.ownerName ?? i18n("A colleague") },
                      )
                    : recording.kind === "mail"
                      ? i18n(
                            "Private email from {owner}, shared with you. You can read it and complete tasks assigned to you. The Organization cannot see it.",
                            {
                                owner:
                                    recording.ownerName ?? i18n("a colleague"),
                            },
                        )
                      : i18n(
                            "Private recording from {owner}, shared with you. You can read it and complete tasks assigned to you. The Organization cannot see it.",
                            {
                                owner:
                                    recording.ownerName ?? i18n("a colleague"),
                            },
                        )}
            </p>
            {recording.receivedFolderIds?.map((id) => {
                const folder = folders.find((folder) => folder.id === id);
                return folder ? (
                    <span
                        key={id}
                        className="inline-flex items-center gap-2 rounded border border-person-share/30 px-2 py-1 text-sm text-person-share"
                    >
                        <FolderInput className="size-4" />
                        {folder.name}
                    </span>
                ) : null;
            })}
            {recording.receivedShare && (
                <Button
                    variant="outline"
                    size="sm"
                    className="text-person-share"
                    onClick={() => setFiling(true)}
                >
                    <FolderInput className="size-4" />
                    {folders.find(
                        (folder) =>
                            folder.id ===
                            recording.receivedShare?.filingFolderId,
                    )?.name ?? i18n("Choose a folder")}
                </Button>
            )}
            {recording.receivedShare && (
                <FolderPicker
                    folders={folders}
                    assignedIds={new Set()}
                    open={filing}
                    onOpenChange={setFiling}
                    scope="personal"
                    onSelect={async (folderId) => {
                        const share = recording.receivedShare;
                        if (!share) return;
                        try {
                            await changeShare(
                                share.id,
                                share.version,
                                "file",
                                folderId,
                            );
                            refresh();
                        } catch (error) {
                            toast.error(
                                error instanceof Error
                                    ? error.message
                                    : i18n("Could not update sharing"),
                            );
                            throw error;
                        }
                    }}
                />
            )}
        </div>
    );
}
