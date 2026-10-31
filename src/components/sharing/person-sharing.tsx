"use client";

import {
    AudioLines,
    Check,
    FolderInput,
    FolderOutput,
    Inbox,
    Link,
    Lock,
    Mail,
    UserPlus,
} from "lucide-react";
import { useExtracted, useFormatter } from "next-intl";
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
import {
    closeCornerNotice,
    showCornerNotice,
} from "@/components/dashboard/corner-notice";
import type { CreatedFolder } from "@/components/pipeline/new-folder-form";
import {
    changeFolderShareRequest,
    ReceivedFolderDialog,
} from "@/components/sharing/folder-sharing";
import { ReceivedItemDialog } from "@/components/sharing/received-item-dialog";
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
import { ActionTooltip } from "@/components/ui/tooltip";
import { useDashboardRefresh } from "@/hooks/use-dashboard-refresh";
import { getApiErrorMessage, parseApiError } from "@/lib/api-errors";
import { subscribeEvents } from "@/lib/events/client";
import type { listMyFolderInvitations } from "@/lib/sharing/folder-shares";
import type {
    listItemFolderAudience,
    listItemShares,
    listMyInvitations,
} from "@/lib/sharing/person-shares";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

type Share = Awaited<ReturnType<typeof listItemShares>>[number];
type FolderAudience = Awaited<ReturnType<typeof listItemFolderAudience>>;
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
    const refresh = useDashboardRefresh();
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
    fallbackMessage: string,
    folderId?: string,
) {
    const response = await fetch(`/api/shares/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, version, folderId }),
    });
    if (!response.ok) {
        const error = await parseApiError(response);
        throw new Error(
            error.code === "UNKNOWN_ERROR"
                ? fallbackMessage
                : error.error || fallbackMessage,
        );
    }
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
    onChanged?: (shares: Share[], folderAudience: FolderAudience) => void;
    allowInvite?: boolean;
}) {
    const i18n = useExtracted();
    const refreshSharing = usePersonSharingRefresh();
    const endpoint =
        kind === "folder"
            ? `/api/folders/${encodeURIComponent(itemId)}/shares`
            : `/api/items/${encodeURIComponent(itemId)}/shares`;
    const [shares, setShares] = useState<Share[]>([]);
    const [folderAudience, setFolderAudience] = useState<FolderAudience>([]);
    const [managingFolder, setManagingFolder] = useState<{
        id: string;
        name: string;
    } | null>(null);
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
        const data = (await response.json()) as {
            shares: Share[];
            folderAudience?: FolderAudience;
        };
        setShares(data.shares);
        setFolderAudience(data.folderAudience ?? []);
        onChanged?.(data.shares, data.folderAudience ?? []);
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
                        folderAudience.some(
                            (member) => member.receiverUserId === person.id,
                        ) ||
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
                        {folderAudience.some(
                            (member) => member.receiverUserId === person.id,
                        ) ? (
                            <div className="space-y-1 text-xs text-person-share">
                                {folderAudience
                                    .filter(
                                        (member) =>
                                            member.receiverUserId === person.id,
                                    )
                                    .map((member) => (
                                        <p key={member.folderId}>
                                            {member.state === "accepted"
                                                ? i18n(
                                                      "Already sees it through {folder}",
                                                      {
                                                          folder: member.folderName,
                                                      },
                                                  )
                                                : i18n(
                                                      "Invited to folder {folder}",
                                                      {
                                                          folder: member.folderName,
                                                      },
                                                  )}
                                        </p>
                                    ))}
                            </div>
                        ) : (
                            <Button
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                    void act(() => invite(person.id))
                                }
                            >
                                {i18n("Add")}
                            </Button>
                        )}
                    </div>
                ))}
            <p className="text-sm font-medium">{i18n("Shared with")}</p>
            <div className="max-h-72 space-y-2 overflow-auto">
                {[
                    ...new Map(
                        folderAudience.map((member) => [
                            member.folderId,
                            member,
                        ]),
                    ).values(),
                ].map((folder) => (
                    <section key={folder.folderId} className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <h4 className="flex items-center gap-1 font-medium text-person-share">
                                <FolderOutput className="size-4" />
                                {i18n("Through folder {folder}", {
                                    folder: folder.folderName,
                                })}
                            </h4>
                            {folder.canManage && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                        setManagingFolder({
                                            id: folder.folderId,
                                            name: folder.folderName,
                                        })
                                    }
                                >
                                    {i18n("Manage folder sharing")}
                                </Button>
                            )}
                        </div>
                        {folderAudience
                            .filter(
                                (member) => member.folderId === folder.folderId,
                            )
                            .map((member) => (
                                <div
                                    key={member.receiverUserId}
                                    className="flex items-center justify-between gap-2 rounded border p-2"
                                >
                                    <div>
                                        {member.name ?? member.email}
                                        <p className="text-xs text-muted-foreground">
                                            {member.email}
                                        </p>
                                    </div>
                                    <span className="text-xs">
                                        {member.state === "accepted"
                                            ? i18n("Accepted")
                                            : i18n("Waiting for acceptance")}
                                    </span>
                                </div>
                            ))}
                    </section>
                ))}
                {kind !== "folder" && (
                    <h4 className="text-xs font-medium text-muted-foreground">
                        {i18n("Directly")}
                    </h4>
                )}
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
                            {((allowInvite &&
                                !folderAudience.some(
                                    (member) =>
                                        member.receiverUserId ===
                                        share.receiverUserId,
                                )) ||
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
                                                ? kind === "folder"
                                                    ? changeFolderShareRequest(
                                                          share.id,
                                                          share.version,
                                                          share.state ===
                                                              "pending"
                                                              ? "cancel"
                                                              : "remove",
                                                          i18n(
                                                              "Could not update sharing",
                                                          ),
                                                      )
                                                    : changeShare(
                                                          share.id,
                                                          share.version,
                                                          share.state ===
                                                              "pending"
                                                              ? "cancel"
                                                              : "remove",
                                                          i18n(
                                                              "Could not update sharing",
                                                          ),
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
                          "The folder and its items stay yours. Sharing with people does not share them with the Organization.",
                      )
                    : allowInvite
                      ? i18n(
                            "This stays your private item. The Organization will not see it. People who see it through a folder stop seeing it when you take it out of that folder.",
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
    const folderDialog = managingFolder && (
        <PersonShareDialog
            itemId={managingFolder.id}
            title={managingFolder.name}
            kind="folder"
            open
            onOpenChange={(open) => {
                if (!open) {
                    setManagingFolder(null);
                    void load().catch((error) => setError(String(error)));
                }
            }}
        />
    );
    if (inline)
        return (
            <div className="space-y-3">
                {content}
                {folderDialog}
            </div>
        );
    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
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
            {folderDialog}
        </>
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
    const [shares, setShares] = useState<Share[] | null>(null);
    const [folderAudience, setFolderAudience] = useState<FolderAudience>([]);
    const sharingChanged = useCallback(
        (shares: Share[], audience: FolderAudience) => {
            setShares(shares);
            setFolderAudience(audience);
        },
        [],
    );
    const load = useCallback(async () => {
        setShares(null);
        setFolderAudience([]);
        try {
            const response = await fetch(
                `/api/items/${encodeURIComponent(itemId)}/shares`,
            );
            if (!response.ok) return;
            const data = (await response.json()) as {
                shares: Share[];
                folderAudience?: FolderAudience;
            };
            sharingChanged(data.shares, data.folderAudience ?? []);
        } catch {
            setShares(null);
        }
    }, [itemId, sharingChanged]);
    useEffect(() => {
        void load();
    }, [load]);
    const active = (shares ?? []).filter(
        (share) => share.state === "pending" || share.state === "accepted",
    );
    const people = [
        ...new Set(
            [...active, ...folderAudience].map(
                (person) => person.receiverUserId,
            ),
        ),
    ].map((id) => {
        const direct = active.find((person) => person.receiverUserId === id);
        const paths = folderAudience.filter(
            (person) => person.receiverUserId === id,
        );
        const person = direct ?? paths[0];
        return {
            ...person,
            receiverUserId: id,
            paths,
            pending:
                direct?.state !== "accepted" &&
                !paths.some((path) => path.state === "accepted"),
        };
    });
    useEffect(() => {
        if (shares !== null) onCountChange(people.length);
    }, [shares, people.length, onCountChange]);
    useEffect(
        () =>
            subscribeEvents((event) => {
                if (event.type === "share") void load();
            }),
        [load],
    );
    return (
        <>
            {(!shared ||
                (shares !== null &&
                    shares.length > 0 &&
                    active.length === 0)) && (
                <ActionTooltip
                    label={shared ? i18n("Manage sharing") : i18n("Share")}
                >
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        className={
                            people.length > 0
                                ? "text-person-share hover:text-person-share"
                                : undefined
                        }
                        aria-label={
                            shared ? i18n("Manage sharing") : i18n("Share")
                        }
                        onClick={() => setDialogOpen(true)}
                    >
                        <UserPlus className="size-4" />
                    </Button>
                </ActionTooltip>
            )}
            {shared ? (
                children
            ) : (
                <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
                    <ActionTooltip label={i18n("Copy link")}>
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
                    </ActionTooltip>
                    <PopoverContent
                        title={i18n("Link access")}
                        className="w-80 space-y-3"
                    >
                        <p className="font-medium">
                            {shares === null
                                ? i18n("Link access")
                                : people.length
                                  ? i18n(
                                        "You and {count, plural, one {# person} other {# people}} can open this link",
                                        { count: people.length },
                                    )
                                  : i18n("Only you can open this link")}
                        </p>
                        {people.length ? (
                            <ul className="text-sm">
                                {people.map((share) => (
                                    <li key={share.receiverUserId}>
                                        {share.name ?? share.email}
                                        {share.paths.map((path) => (
                                            <span
                                                key={path.folderId}
                                                className="text-person-share"
                                            >{` (${i18n("through {folder}", { folder: path.folderName })})`}</span>
                                        ))}
                                        {share.pending
                                            ? ` (${i18n("Waiting for acceptance")})`
                                            : ""}
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-sm text-muted-foreground">
                                {shares === null
                                    ? i18n(
                                          "This is a private link. Access depends on the item’s sharing settings.",
                                      )
                                    : i18n(
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
                                {shares === null || people.length
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
                                {shares === null || people.length
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
                onChanged={sharingChanged}
                allowInvite={!shared}
            />
        </>
    );
}

const INVITATION_NOTICES_SEEN_KEY = "chatterbox.invitation-notices-seen";
const INVITATION_FALLBACK_INTERVAL_MS = 60_000;
const INVITATION_CONNECTED_INTERVAL_MS = 5 * 60_000;

/** Invitations whose notice this browser has already shown and closed. */
function invitationNoticesSeen(): Set<string> {
    try {
        const ids: unknown = JSON.parse(
            window.localStorage.getItem(INVITATION_NOTICES_SEEN_KEY) ?? "[]",
        );
        return new Set(
            Array.isArray(ids)
                ? ids.filter((id): id is string => typeof id === "string")
                : [],
        );
    } catch {
        return new Set();
    }
}

function markInvitationNoticesSeen(invitations: Invitation[]) {
    try {
        window.localStorage.setItem(
            INVITATION_NOTICES_SEEN_KEY,
            JSON.stringify(invitations.map((item) => item.id)),
        );
    } catch {}
}

function InvitationCard({
    invitation,
    onAccept,
    onFile,
    onDecline,
}: {
    invitation: Invitation;
    onAccept: () => void;
    onFile: () => void;
    onDecline: () => void;
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    const paths =
        invitation.kind === "folder" ? [] : (invitation.visibleInFolders ?? []);
    const Icon =
        invitation.kind === "folder"
            ? FolderInput
            : invitation.kind === "mail"
              ? Mail
              : AudioLines;
    return (
        <article
            className={`space-y-3 rounded-lg border p-4 ${paths.length ? "border-person-share/40 bg-person-share/5" : "bg-muted/20"}`}
        >
            <div className="flex items-start gap-3">
                <Icon
                    className={`size-9 shrink-0 rounded-lg p-2 ${invitation.kind === "folder" ? "bg-person-share/10 text-person-share" : "bg-muted"}`}
                />
                <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {invitation.kind === "folder"
                            ? i18n("Folder")
                            : invitation.kind === "mail"
                              ? i18n("Email")
                              : i18n("Recording")}
                    </p>
                    <h3 className="font-medium [overflow-wrap:anywhere]">
                        {invitation.title}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                        {i18n("Shared by {owner}", {
                            owner: invitation.ownerName,
                        })}{" "}
                        · {format.dateTime(new Date(invitation.invitedAt))}
                    </p>
                </div>
            </div>
            {paths.length > 0 && (
                <p className="flex flex-wrap items-center gap-2 text-sm">
                    <Check className="size-4 text-person-share" />
                    {i18n("Already in your folder")}
                    {paths.map((folder) => (
                        <span
                            key={folder.id}
                            className="inline-flex items-center gap-1 rounded border border-person-share/30 px-2 py-1 text-person-share"
                        >
                            <FolderInput className="size-4" />
                            {folder.name}
                        </span>
                    ))}
                </p>
            )}
            <p className="text-sm leading-relaxed">
                {invitation.kind === "folder"
                    ? i18n(
                          "It becomes a new folder in your tree. You see everything directly in it, including what is added later.",
                      )
                    : paths.length
                      ? invitation.kind === "mail"
                          ? i18n(
                                "{owner} also shared it with you separately. Accepting adds nothing new, it only keeps the email if it leaves {folder}.",
                                {
                                    owner: invitation.ownerName,
                                    folder: paths
                                        .map((folder) => folder.name)
                                        .join(", "),
                                },
                            )
                          : i18n(
                                "{owner} also shared it with you separately. Accepting adds nothing new, it only keeps the recording if it leaves {folder}.",
                                {
                                    owner: invitation.ownerName,
                                    folder: paths
                                        .map((folder) => folder.name)
                                        .join(", "),
                                },
                            )
                      : invitation.kind === "mail"
                        ? i18n(
                              "You can read the email and summary and complete tasks assigned to you. Besides you, only {owner} and the people they invite see it.",
                              { owner: invitation.ownerName },
                          )
                        : i18n(
                              "You can read the transcript and summary and complete tasks assigned to you. Besides you, only {owner} and the people they invite see it.",
                              { owner: invitation.ownerName },
                          )}
            </p>
            <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={onAccept}>
                    {paths.length ? i18n("Accept") : i18n("Accept…")}
                </Button>
                {paths.length > 0 && (
                    <Button size="sm" variant="ghost" onClick={onFile}>
                        {i18n("File elsewhere too…")}
                    </Button>
                )}
                <Button size="sm" variant="outline" onClick={onDecline}>
                    {i18n("Decline")}
                </Button>
            </div>
        </article>
    );
}

/**
 * Invitation count, waiting list, folder acceptance and arrival notice.
 * Only the instance with notifications watches for new invitations; others follow the page refresh it triggers.
 */
export function PersonInvitations({
    initialInvitations,
    folders,
    onFolderCreated,
    notifications = true,
}: {
    initialInvitations: Invitation[];
    folders: RecordingFolder[];
    onFolderCreated?: (folder: CreatedFolder) => void;
    notifications?: boolean;
}) {
    const enabled = usePersonSharing();
    const i18n = useExtracted();
    const refresh = useDashboardRefresh();
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
    const [filingAlso, setFilingAlso] = useState(false);
    const filingSaved = useRef(false);
    const closeFiling = (open: boolean) => {
        if (!open) {
            setFiling(null);
            setOpen(!filingSaved.current && invitations.length > 0);
        }
    };
    const known = useRef(new Set(initialInvitations.map((item) => item.id)));
    useEffect(() => {
        setInvitations(initialInvitations);
    }, [initialInvitations]);
    const openList = useCallback((list: Invitation[]) => {
        markInvitationNoticesSeen(list);
        closeCornerNotice("invitation");
        setOpen(true);
    }, []);
    const notify = useCallback(
        (list: Invitation[], newest: Invitation) =>
            showCornerNotice("invitation", () => (
                <ArrivalNotice
                    recording={{
                        id: newest.itemId,
                        kind: newest.kind === "folder" ? "audio" : newest.kind,
                        filename: newest.title,
                        startTime: String(newest.invitedAt),
                        duration: 0,
                        filesize: 0,
                        deviceSn: "",
                        ownerName: newest.ownerName,
                    }}
                    invitation
                    folderInvitation={newest.kind === "folder"}
                    more={list.length - 1}
                    dateTimeFormat="relative"
                    onOpen={() => openList(list)}
                    onClose={() => {
                        markInvitationNoticesSeen(list);
                        closeCornerNotice("invitation");
                    }}
                />
            )),
        [openList],
    );
    useEffect(() => {
        if (!enabled || !notifications) return;
        const seen = invitationNoticesSeen();
        const newest = initialInvitations
            .filter((item) => !seen.has(item.id))
            .at(-1);
        if (newest) notify(initialInvitations, newest);
    }, [enabled, notifications, initialInvitations, notify]);
    useEffect(() => {
        if (!enabled || !notifications) return;
        return () => closeCornerNotice("invitation");
    }, [enabled, notifications]);
    useEffect(() => {
        if (!enabled || !notifications) return;
        let active = true;
        let pollTimer: ReturnType<typeof setInterval> | undefined;
        let pollInterval = 0;
        const check = async (pushed: boolean) => {
            try {
                const response = await fetch("/api/shares");
                if (!response.ok || !active) return;
                const data = (await response.json()) as {
                    invitations: Invitation[];
                };
                if (!active) return;
                const arrived = data.invitations.filter(
                    (item) => !known.current.has(item.id),
                );
                const changed =
                    arrived.length > 0 ||
                    data.invitations.length !== known.current.size;
                known.current = new Set(
                    data.invitations.map((item) => item.id),
                );
                setInvitations(data.invitations);
                const newest = arrived.at(-1);
                if (newest) notify(data.invitations, newest);
                if (pushed || changed) refresh();
            } catch {}
        };
        const poll = () => {
            if (document.visibilityState === "visible") void check(false);
        };
        const unsubscribe = subscribeEvents(
            (event) => {
                if (event.type === "share") void check(true);
            },
            (state) => {
                const interval =
                    state === "open"
                        ? INVITATION_CONNECTED_INTERVAL_MS
                        : INVITATION_FALLBACK_INTERVAL_MS;
                if (interval === pollInterval) return;
                pollInterval = interval;
                clearInterval(pollTimer);
                pollTimer = setInterval(poll, interval);
            },
        );
        document.addEventListener("visibilitychange", poll);
        return () => {
            active = false;
            unsubscribe();
            clearInterval(pollTimer);
            document.removeEventListener("visibilitychange", poll);
        };
    }, [enabled, notifications, notify, refresh]);
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
                    i18n("Could not update sharing"),
                );
            else
                await changeShare(
                    invitation.id,
                    invitation.version,
                    action,
                    i18n("Could not update sharing"),
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
            {(invitations.length > 0 || open) && (
                <Button
                    className="w-full justify-start gap-2 bg-person-share text-background hover:bg-person-share/90"
                    aria-label={i18n("Invitations ({count})", {
                        count: String(invitations.length),
                    })}
                    onClick={() => openList(invitations)}
                >
                    <Inbox className="size-4" />
                    <span>{i18n("Invitations")}</span>
                    <span className="ml-auto rounded-full bg-background px-2 text-xs font-semibold tabular-nums text-person-share">
                        {invitations.length}
                    </span>
                </Button>
            )}
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
                    <DialogTitle className="flex items-center gap-2">
                        <Inbox className="size-5 text-person-share" />
                        {i18n("Invitations")}
                        <span className="rounded-full bg-person-share px-2 text-xs text-background">
                            {invitations.length}
                        </span>
                    </DialogTitle>
                    <DialogDescription>
                        {i18n(
                            "Colleagues share their private folders, recordings and email with you. You see the content once you accept. The Organization does not.",
                        )}
                    </DialogDescription>
                    {invitations.map((invitation) => (
                        <InvitationCard
                            key={invitation.id}
                            invitation={invitation}
                            onAccept={() => {
                                if (
                                    invitation.kind !== "folder" &&
                                    invitation.visibleInFolders?.length
                                ) {
                                    void respond(invitation, "accept").catch(
                                        () => {},
                                    );
                                } else {
                                    filingSaved.current = false;
                                    setFilingAlso(false);
                                    setFiling(invitation);
                                    setOpen(false);
                                }
                            }}
                            onFile={() => {
                                filingSaved.current = false;
                                setFilingAlso(true);
                                setFiling(invitation);
                                setOpen(false);
                            }}
                            onDecline={() =>
                                void respond(invitation, "decline").catch(
                                    () => {},
                                )
                            }
                        />
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
                    onOpenChange={closeFiling}
                    onSaved={() => {
                        filingSaved.current = true;
                        setInvitations((items) =>
                            items.filter((item) => item.id !== filing.id),
                        );
                        setFiling(null);
                    }}
                />
            )}
            {filing && filing.kind !== "folder" && (
                <ReceivedItemDialog
                    key={filing.id}
                    item={{
                        ...filing,
                        visibleInFolders: filing.visibleInFolders ?? [],
                    }}
                    folders={folders}
                    onFolderCreated={onFolderCreated}
                    initiallyAlso={filingAlso}
                    open
                    onOpenChange={closeFiling}
                    onSave={async (folderId) => {
                        await respond(filing, "accept", folderId);
                        filingSaved.current = true;
                    }}
                />
            )}
        </>
    );
}

/** The receiver's sole editable item property: filing in their own private tree. */
export function ReceivedItemBanner({
    recording,
    folders,
    onFolderCreated,
    shared = false,
}: {
    recording: Recording;
    folders: RecordingFolder[];
    onFolderCreated?: (folder: CreatedFolder) => void;
    shared?: boolean;
}) {
    const i18n = useExtracted();
    const refresh = useDashboardRefresh();
    const [filing, setFiling] = useState(false);
    const [saving, setSaving] = useState(false);
    const paths = (recording.receivedFolderIds ?? []).flatMap((id) => {
        const folder = folders.find((folder) => folder.id === id);
        return folder ? [{ id, name: folder.name }] : [];
    });
    const filingFolder = folders.find(
        (folder) => folder.id === recording.receivedShare?.filingFolderId,
    );
    const saveFiling = async (folderId?: string) => {
        const share = recording.receivedShare;
        if (!share || saving) return;
        setSaving(true);
        try {
            await changeShare(
                share.id,
                share.version,
                "file",
                i18n("Could not update sharing"),
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
        } finally {
            setSaving(false);
        }
    };
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
                    disabled={saving}
                    onClick={() => setFiling(true)}
                >
                    <FolderInput className="size-4" />
                    {filingFolder?.name ??
                        (paths.length
                            ? i18n("File elsewhere too…")
                            : i18n("Choose a folder"))}
                </Button>
            )}
            {recording.receivedShare?.filingFolderId && paths.length > 0 && (
                <Button
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={() => void saveFiling().catch(() => {})}
                >
                    {i18n("Remove from {folder}", {
                        folder: filingFolder?.name ?? i18n("folder"),
                    })}
                </Button>
            )}
            {recording.receivedShare && (
                <ReceivedItemDialog
                    key={`${recording.id}:${filing}`}
                    item={{
                        title: recording.filename,
                        kind: recording.kind ?? "audio",
                        ownerName: recording.ownerName ?? i18n("A colleague"),
                        visibleInFolders: paths,
                    }}
                    folders={folders}
                    action="file"
                    initiallyAlso
                    initialFolderId={recording.receivedShare.filingFolderId}
                    open={filing}
                    onOpenChange={setFiling}
                    onSave={saveFiling}
                    onFolderCreated={onFolderCreated}
                />
            )}
        </div>
    );
}
