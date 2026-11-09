"use client";

import { useRouter } from "next/navigation";
import { RecordingFolderTags } from "@/components/recordings/recording-folder-tags";
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
    const router = useRouter();
    const own = detail.userId === userId && !disabled;
    const itemId = detail.meetingItemId ?? detail.id;
    const navigationId = (id: string) =>
        folders.find((folder) => folder.receivedFolder?.sourceFolderId === id)
            ?.id ?? id;
    const sourceId = (id: string) =>
        folders.find((folder) => folder.id === id)?.receivedFolder
            ?.sourceFolderId ?? id;
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
        </div>
    );
}
