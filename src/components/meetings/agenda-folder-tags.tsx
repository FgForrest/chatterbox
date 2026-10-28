"use client";

import { FolderInput } from "lucide-react";
import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { useRef, useState } from "react";
import { FolderPicker } from "@/components/recordings/folder-picker";
import { RecordingFolderTags } from "@/components/recordings/recording-folder-tags";
import { Button } from "@/components/ui/button";
import type { RecordingFolder } from "@/types/folder";
import type { MeetingDetail } from "./types";
import type { AgendaController } from "./use-agenda";

export function AgendaFolderTags({
    detail,
    userId,
    folders,
    disabled,
    mutate,
    onChanged,
}: {
    detail: MeetingDetail;
    userId?: string;
    folders: RecordingFolder[];
    disabled: boolean;
    mutate: AgendaController["mutate"];
    onChanged?: () => void;
}) {
    const i18n = useExtracted();
    const router = useRouter();
    const [moving, setMoving] = useState(false);
    const [source, setSource] = useState<string | null>(null);
    const selectingSource = useRef(false);
    const own = detail.userId === userId && !disabled;
    const itemId = detail.meetingItemId ?? detail.id;
    const navigationId = (id: string) =>
        folders.find((folder) => folder.receivedFolder?.sourceFolderId === id)
            ?.id ?? id;
    const sourceId = (id: string) =>
        folders.find((folder) => folder.id === id)?.receivedFolder
            ?.sourceFolderId ?? id;
    const assigned = new Set(
        detail.folders.map((folder) => navigationId(folder.id)),
    );
    const available = [
        ...folders,
        ...detail.folders
            .filter(
                (folder) =>
                    !folders.some(
                        (entry) =>
                            entry.id === folder.id ||
                            entry.receivedFolder?.sourceFolderId === folder.id,
                    ),
            )
            .map((folder) => ({
                ...folder,
                kind: "custom" as const,
                scope: "personal" as const,
                sortOrder: 0,
                version: 0,
            })),
    ];
    const path = `/api/recordings/${encodeURIComponent(itemId)}/folders`;
    const change = async (
        method: string,
        body: unknown,
        optimistic: (value: MeetingDetail) => MeetingDetail,
    ) => {
        if (!(await mutate(path, method, body, optimistic)))
            throw new Error("Filing failed");
        onChanged?.();
    };
    const addFolder = (value: MeetingDetail, folderId: string) => {
        const folder = available.find((folder) => folder.id === folderId);
        return folder
            ? [
                  ...value.folders.filter(
                      (entry) => entry.id !== sourceId(folderId),
                  ),
                  {
                      id: sourceId(folder.id),
                      name: folder.name,
                      parentId: folder.parentId,
                      userId: folder.scope === "org" ? "" : (userId ?? ""),
                  },
              ]
            : value.folders;
    };
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
            <RecordingFolderTags
                recordingId={itemId}
                kind="meeting"
                folders={available}
                assignments={detail.folders.map((folder) => ({
                    recordingId: itemId,
                    folderId: navigationId(folder.id),
                }))}
                isOwn={own}
                canWithdraw={
                    !disabled &&
                    (own ||
                        detail.folders.some(
                            (folder) =>
                                folder.userId === userId &&
                                available.find(
                                    (entry) => entry.id === folder.id,
                                )?.scope === "org",
                        ))
                }
                canUnfilePersonal={(folder) =>
                    !disabled &&
                    detail.folders.some(
                        (entry) =>
                            entry.id === sourceId(folder.id) &&
                            entry.userId === userId,
                    )
                }
                onSelectFolder={(folder) =>
                    router.push(
                        `/dashboard?folder=${encodeURIComponent(folder.id)}`,
                    )
                }
                onAdd={async (_, folderId) =>
                    change("POST", { folderId }, (value) => ({
                        ...value,
                        folders: addFolder(value, folderId),
                    }))
                }
                onRemove={async (_, folderId, withdraw) =>
                    change("DELETE", { folderId, withdraw }, (value) => ({
                        ...value,
                        folders: value.folders.filter(
                            (folder) => folder.id !== sourceId(folderId),
                        ),
                    }))
                }
                onMove={
                    !disabled
                        ? async (_, fromFolderId, toFolderId) =>
                              change(
                                  "PATCH",
                                  { fromFolderId, toFolderId, withdraw: true },
                                  (value) => ({
                                      ...value,
                                      folders: addFolder(
                                          {
                                              ...value,
                                              folders: value.folders.filter(
                                                  (folder) =>
                                                      folder.id !==
                                                      sourceId(fromFolderId),
                                              ),
                                          },
                                          toFolderId,
                                      ),
                                  }),
                              )
                        : undefined
                }
            />
            {own && assigned.size > 0 && (
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 rounded-full border border-dashed px-2.5 text-xs text-muted-foreground"
                    onClick={() => {
                        setSource(
                            assigned.size === 1 ? [...assigned][0] : null,
                        );
                        setMoving(true);
                    }}
                >
                    <FolderInput className="size-3.5" />
                    {i18n("Move to…")}
                </Button>
            )}
            {moving && (
                <FolderPicker
                    key={source ?? "source"}
                    folders={
                        source
                            ? available
                            : available.filter((folder) =>
                                  assigned.has(folder.id),
                              )
                    }
                    assignedIds={source ? assigned : new Set()}
                    allowCreate={Boolean(source)}
                    open
                    onOpenChange={(open) => {
                        if (!open && selectingSource.current) {
                            selectingSource.current = false;
                            return;
                        }
                        setMoving(open);
                    }}
                    title={source ? i18n("Move to…") : i18n("Move from…")}
                    onSelect={async (folderId) => {
                        if (!source) {
                            selectingSource.current = true;
                            setSource(folderId);
                            return;
                        }
                        await change(
                            "PATCH",
                            {
                                fromFolderId: source,
                                toFolderId: folderId,
                                withdraw: true,
                            },
                            (value) => ({
                                ...value,
                                folders: addFolder(
                                    {
                                        ...value,
                                        folders: value.folders.filter(
                                            (folder) =>
                                                folder.id !== sourceId(source),
                                        ),
                                    },
                                    folderId,
                                ),
                            }),
                        );
                    }}
                />
            )}
        </div>
    );
}
