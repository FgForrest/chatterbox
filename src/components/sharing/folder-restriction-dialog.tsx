"use client";

import { FolderLock } from "lucide-react";
import { useExtracted, useFormatter } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { HelpLink } from "@/components/help/help-button";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
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

interface ItemPreview {
    id: string;
    kind: string;
    ownerUserId: string;
    ownerName: string | null;
    ownerEmail: string;
    occurredAt: string;
}
interface RestrictPreview {
    items: ItemPreview[];
    withdrawnItems: ItemPreview[];
    retainedAlmanacAdditions: { kind: "person" | "entity"; targetId: string }[];
    exports: { id: string; provider: string }[];
}
interface LiftItem extends ItemPreview {
    problems: { code: string }[];
    graceEndsAt: string;
    reachedByOrganizationRetention: boolean;
}
interface LiftPreview {
    items: LiftItem[];
    sharedNow: LiftItem[];
    pending: LiftItem[];
    graceEndsAt: string;
}

/** Restrict and lift previews and their transition action in one dialog body. */
export function FolderRestrictionDialog({
    folder,
    folders,
    action,
    onOpenChange,
}: {
    folder: RecordingFolder;
    folders: RecordingFolder[];
    action: "restrict" | "lift";
    onOpenChange: (open: boolean) => void;
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    const request = useRestrictedFolderRequest();
    const { writable } = useRestrictedFolders();
    const refresh = useDashboardRefresh();
    const [restriction, setRestriction] = useState<RestrictPreview | null>(
        null,
    );
    const [lift, setLift] = useState<LiftPreview | null>(null);
    const [fixed, setFixed] = useState<AudiencePerson[]>([]);
    const [audience, setAudience] = useState<AudiencePerson[]>([]);
    const [labels, setLabels] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [hasChildren, setHasChildren] = useState(
        folders.some((entry) => entry.parentId === folder.id),
    );
    const endpoint = `/api/folders/${encodeURIComponent(folder.id)}/${action}`;
    const fallbackMessage = i18n("Could not update folder. Please try again.");
    const fail = useCallback(
        (error: unknown) => {
            const message =
                error instanceof Error ? error.message : fallbackMessage;
            if (error instanceof FolderRequestError && error.status === 403) {
                toast.error(message);
                onOpenChange(false);
                refresh();
            } else if (
                error instanceof FolderRequestError &&
                error.code === "RESTRICTED_FOLDER_HAS_CHILDREN"
            )
                setHasChildren(true);
            else setError(message);
        },
        [fallbackMessage, onOpenChange, refresh],
    );
    useEffect(() => {
        if (
            !writable ||
            folder.access === false ||
            (action === "restrict" && hasChildren)
        )
            return;
        let cancelled = false;
        void (async () => {
            if (action === "lift") {
                const data = await request<LiftPreview>(endpoint);
                if (!cancelled) setLift(data);
                return;
            }
            const data = await request<RestrictPreview>(endpoint);
            const owners = data.items.map((item) => ({
                id: item.ownerUserId,
                name: item.ownerName,
                email: item.ownerEmail,
            }));
            if (folder.restricting) {
                const existing = await request<{
                    members: {
                        userId: string;
                        name: string | null;
                        email: string;
                    }[];
                }>(`/api/folders/${encodeURIComponent(folder.id)}/audience`);
                owners.push(
                    ...existing.members.map((member) => ({
                        id: member.userId,
                        name: member.name,
                        email: member.email,
                    })),
                );
            }
            if (!cancelled) {
                setRestriction(data);
                setFixed([
                    ...new Map(
                        owners.map((owner) => [owner.id, owner]),
                    ).values(),
                ]);
            }
            const additions = [
                ...new Map(
                    data.retainedAlmanacAdditions.map((entry) => [
                        `${entry.kind}:${entry.targetId}`,
                        entry,
                    ]),
                ).values(),
            ];
            const resolved = await Promise.all(
                additions.map(async (entry) => {
                    const response = await fetch(
                        entry.kind === "person"
                            ? `/api/people/${encodeURIComponent(entry.targetId)}`
                            : `/api/knowledge/entities/${encodeURIComponent(entry.targetId)}`,
                    );
                    if (!response.ok) return null;
                    const result = (await response.json()) as {
                        person?: { displayName: string };
                        entity?: { name: string };
                    };
                    return [
                        `${entry.kind}:${entry.targetId}`,
                        result.person?.displayName ?? result.entity?.name ?? "",
                    ] as const;
                }),
            );
            if (!cancelled)
                setLabels(
                    Object.fromEntries(
                        resolved.filter((entry) => entry !== null),
                    ),
                );
        })().catch((error) => {
            if (!cancelled) fail(error);
        });
        return () => {
            cancelled = true;
        };
    }, [
        action,
        endpoint,
        folder.id,
        folder.access,
        folder.restricting,
        hasChildren,
        request,
        writable,
        fail,
    ]);
    if (!writable || folder.access === false) return null;
    const withdrawnCounts = { audio: 0, mail: 0, meeting: 0 };
    for (const item of restriction?.withdrawnItems ?? []) {
        if (
            item.kind === "audio" ||
            item.kind === "mail" ||
            item.kind === "meeting"
        )
            withdrawnCounts[item.kind]++;
    }
    const title =
        action === "restrict"
            ? i18n("Restrict folder")
            : i18n("Open to the whole Organization");
    const ready = action === "restrict" ? restriction !== null : lift !== null;
    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <FolderLock className="size-5 text-restricted" />
                        {title}
                        <HelpLink
                            topic="folders.restricted"
                            label={i18n("restricted folders")}
                        />
                    </DialogTitle>
                    <DialogDescription>{folder.name}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4 text-sm">
                    {hasChildren && action === "restrict" ? (
                        <p role="alert">
                            {i18n(
                                "Move this folder's subfolders elsewhere first. A restricted folder has no subfolders.",
                            )}
                        </p>
                    ) : (
                        <>
                            {!ready && !error && (
                                <output>{i18n("Loading…")}</output>
                            )}
                            {restriction && (
                                <>
                                    <h3 className="font-medium">
                                        {i18n("Who will see it")}
                                    </h3>
                                    <RestrictedAudiencePicker
                                        fixed={fixed}
                                        selected={audience}
                                        onChange={setAudience}
                                        disabled={busy}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        {i18n(
                                            "Item owners join the audience when the folder is restricted. Managers and curators can remove them later without unfiling their items.",
                                        )}
                                    </p>
                                    {restriction.withdrawnItems.length > 0 && (
                                        <div className="rounded-lg border border-restricted/30 bg-restricted/5 p-3">
                                            <h3 className="font-medium">
                                                {i18n(
                                                    "Withdrawn from the Organization",
                                                )}
                                            </h3>
                                            <p>
                                                {i18n(
                                                    "{count, plural, one {# item} other {# items}}",
                                                    {
                                                        count: restriction
                                                            .withdrawnItems
                                                            .length,
                                                    },
                                                )}
                                            </p>
                                            {[
                                                {
                                                    count: withdrawnCounts.audio,
                                                    label: i18n(
                                                        "Recordings: {count, number}",
                                                        {
                                                            count: withdrawnCounts.audio,
                                                        },
                                                    ),
                                                },
                                                {
                                                    count: withdrawnCounts.mail,
                                                    label: i18n(
                                                        "Mail: {count, number}",
                                                        {
                                                            count: withdrawnCounts.mail,
                                                        },
                                                    ),
                                                },
                                                {
                                                    count: withdrawnCounts.meeting,
                                                    label: i18n(
                                                        "Agendas: {count, number}",
                                                        {
                                                            count: withdrawnCounts.meeting,
                                                        },
                                                    ),
                                                },
                                            ]
                                                .filter(
                                                    (entry) => entry.count > 0,
                                                )
                                                .map((entry) => (
                                                    <p key={entry.label}>
                                                        {entry.label}
                                                    </p>
                                                ))}
                                        </div>
                                    )}
                                    <div className="flex flex-col gap-2 rounded-lg border p-3">
                                        <h3 className="font-medium">
                                            {i18n("Cannot be undone")}
                                        </h3>
                                        <p>
                                            {i18n(
                                                "People and things already added to the Organization Almanac stay there. Older additions may not all be listed.",
                                            )}
                                        </p>
                                        <ul className="list-disc pl-4">
                                            {[
                                                ...new Set(
                                                    restriction.retainedAlmanacAdditions.map(
                                                        (entry) =>
                                                            `${entry.kind}:${entry.targetId}`,
                                                    ),
                                                ),
                                            ].map((key) => (
                                                <li key={key}>
                                                    {labels[key] ||
                                                        i18n(
                                                            "Almanac record unavailable",
                                                        )}
                                                </li>
                                            ))}
                                        </ul>
                                        <a
                                            className="underline"
                                            href="/almanac/care?section=shares"
                                        >
                                            {i18n(
                                                "Review additions from sharing",
                                            )}
                                        </a>
                                        <p>
                                            {i18n(
                                                "People who saw this folder may have downloaded its items.",
                                            )}
                                        </p>
                                        {restriction.exports.length > 0 && (
                                            <>
                                                <p>
                                                    {i18n(
                                                        "Existing Organization exports may already have written files. Tracked copies will be removed; previous downloads cannot be recalled.",
                                                    )}
                                                </p>
                                                <ul className="list-disc pl-4">
                                                    {restriction.exports.map(
                                                        (entry) => (
                                                            <li key={entry.id}>
                                                                {entry.provider}
                                                            </li>
                                                        ),
                                                    )}
                                                </ul>
                                            </>
                                        )}
                                    </div>
                                </>
                            )}
                            {lift && (
                                <>
                                    {lift.sharedNow.length > 0 && (
                                        <section>
                                            <h3 className="font-medium">
                                                {i18n(
                                                    "Shared now: {count, number}",
                                                    {
                                                        count: lift.sharedNow
                                                            .length,
                                                    },
                                                )}
                                            </h3>
                                            <p>
                                                {i18n(
                                                    "Speaker names, facts and transcript corrections reach the Organization Almanac through normal sharing.",
                                                )}
                                            </p>
                                            <PreviewItems
                                                items={lift.sharedNow}
                                            />
                                        </section>
                                    )}
                                    {lift.pending.length > 0 && (
                                        <section>
                                            <h3 className="font-medium">
                                                {i18n(
                                                    "Waiting for their owner: {count, number}",
                                                    {
                                                        count: lift.pending
                                                            .length,
                                                    },
                                                )}
                                            </h3>
                                            <p>
                                                {i18n(
                                                    "Items waiting for speaker naming or other sharing requirements stay visible to the current audience until their owner finishes them.",
                                                )}
                                            </p>
                                            <PreviewItems
                                                items={lift.pending}
                                            />
                                        </section>
                                    )}
                                    {lift.items.some(
                                        (item) =>
                                            item.reachedByOrganizationRetention,
                                    ) && (
                                        <section>
                                            <h3 className="font-medium">
                                                {i18n("Organization retention")}
                                            </h3>
                                            <p>
                                                {i18n(
                                                    "The 30-day grace ends on {date}. Later releases start their own grace period.",
                                                    {
                                                        date: format.dateTime(
                                                            new Date(
                                                                lift.graceEndsAt,
                                                            ),
                                                            {
                                                                dateStyle:
                                                                    "long",
                                                            },
                                                        ),
                                                    },
                                                )}
                                            </p>
                                            <PreviewItems
                                                items={lift.items.filter(
                                                    (item) =>
                                                        item.reachedByOrganizationRetention,
                                                )}
                                            />
                                        </section>
                                    )}
                                    <p>
                                        {i18n(
                                            "Restricting the folder again cannot recall what reached the Organization Almanac.",
                                        )}
                                    </p>
                                </>
                            )}
                        </>
                    )}
                    {error && (
                        <p role="alert" className="text-destructive">
                            {error}
                        </p>
                    )}
                </div>
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        {i18n("Cancel")}
                    </Button>
                    {!(hasChildren && action === "restrict") && (
                        <Button
                            disabled={busy || !ready}
                            onClick={async () => {
                                setBusy(true);
                                setError(null);
                                try {
                                    const result = await request<{
                                        restricting: boolean;
                                        queued: number;
                                    }>(
                                        endpoint,
                                        "POST",
                                        action === "restrict"
                                            ? {
                                                  audienceUserIds: audience.map(
                                                      (person) => person.id,
                                                  ),
                                              }
                                            : undefined,
                                    );
                                    toast.success(
                                        result.restricting
                                            ? i18n("Restricting…")
                                            : action === "restrict"
                                              ? i18n("Folder restricted")
                                              : i18n(
                                                    "Folder opened to the Organization",
                                                ),
                                    );
                                    refresh();
                                    onOpenChange(false);
                                } catch (error) {
                                    fail(error);
                                } finally {
                                    setBusy(false);
                                }
                            }}
                        >
                            {busy ? i18n("Saving…") : title}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function PreviewItems({ items }: { items: ItemPreview[] }) {
    const format = useFormatter();
    if (!items.length) return null;
    return (
        <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
            {items.map((item) => (
                <li key={item.id}>
                    {item.ownerName ?? item.ownerEmail} ·{" "}
                    {format.dateTime(new Date(item.occurredAt), {
                        dateStyle: "medium",
                    })}
                </li>
            ))}
        </ul>
    );
}
