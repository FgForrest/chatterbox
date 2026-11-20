"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
    FolderEdit,
    ItemOperationResult,
    TrackFolderEdit,
} from "@/components/items/item-operation-queue";
import type { FolderOrganization } from "@/types/folder";

interface PendingFolderEdit {
    token: symbol;
    itemId: string;
    apply: FolderEdit["apply"];
    confirmedBy?: number;
}

function applyFolderEdits(
    organization: FolderOrganization,
    edits: PendingFolderEdit[],
) {
    if (edits.length === 0) return organization;
    const edited = new Map<string, string[]>();
    for (const { itemId, apply } of edits) {
        const ids =
            edited.get(itemId) ??
            organization.assignments
                .filter(({ recordingId }) => recordingId === itemId)
                .map(({ folderId }) => folderId);
        edited.set(itemId, apply(ids));
    }
    return {
        ...organization,
        assignments: [
            ...organization.assignments.filter(
                ({ recordingId }) => !edited.has(recordingId),
            ),
            ...[...edited].flatMap(([recordingId, ids]) =>
                ids.map((folderId) => ({ recordingId, folderId })),
            ),
        ],
    };
}

function confirmedEdit(
    base: FolderOrganization,
    processing: ItemOperationResult["processing"],
    edit: FolderEdit,
): FolderEdit["apply"] {
    if (!processing) return edit.apply;
    const known = new Map(base.folders.map((folder) => [folder.id, folder]));
    const placements = processing.placements.map((folder) => folder.id);
    return (ids) => [
        ...new Set([
            ...placements,
            ...ids.filter((id) => {
                const folder = known.get(id);
                return (
                    folder?.receivedFolder ||
                    (processing.access?.role !== "owner" &&
                        folder?.scope === "personal")
                );
            }),
        ]),
    ];
}

/** Keep dashboard folder edits until a fresh, request-ordered snapshot covers them. */
export function useWorkstationFolders(initial: FolderOrganization) {
    const [folderBase, setFolderOrganization] = useState(initial);
    const [folderEdits, setFolderEdits] = useState<PendingFolderEdit[]>([]);
    const requests = useRef({
        sequence: 0,
        active: undefined as AbortController | undefined,
        retry: undefined as ReturnType<typeof setTimeout> | undefined,
    });
    const refreshFolderBase = useCallback(() => {
        const state = requests.current;
        const sequence = ++state.sequence;
        state.active?.abort();
        clearTimeout(state.retry);
        const controller = new AbortController();
        state.active = controller;
        const { signal } = controller;
        let retryDelay = 1_000;
        async function read() {
            try {
                const response = await fetch("/api/folders?dashboard=1", {
                    cache: "no-store",
                    signal,
                });
                if (!response.ok) throw new Error(String(response.status));
                const next: FolderOrganization = await response.json();
                if (
                    !Array.isArray(next?.folders) ||
                    !Array.isArray(next.assignments)
                )
                    throw new Error("Invalid dashboard folder snapshot");
                if (signal.aborted) return;
                setFolderOrganization(next);
                setFolderEdits((edits) =>
                    edits.filter(
                        (edit) =>
                            edit.confirmedBy === undefined ||
                            edit.confirmedBy > sequence,
                    ),
                );
            } catch {
                if (signal.aborted) return;
                state.retry = setTimeout(() => void read(), retryDelay);
                retryDelay = Math.min(retryDelay * 2, 30_000);
            }
        }
        void read();
        return sequence;
    }, []);

    useEffect(() => {
        // Router refreshes do not identify which request supplied their folder props.
        if (requests.current.sequence > 0) refreshFolderBase();
        else setFolderOrganization(initial);
    }, [initial, refreshFolderBase]);

    useEffect(
        () => () => {
            const state = requests.current;
            state.active?.abort();
            clearTimeout(state.retry);
        },
        [],
    );

    const trackFolderEdit = useCallback<TrackFolderEdit>(
        (itemId, edit) => {
            const token = Symbol();
            setFolderEdits((edits) => [
                ...edits,
                { token, itemId, apply: edit.apply },
            ]);
            return (outcome) => {
                if (!outcome) {
                    setFolderEdits((edits) =>
                        edits.filter((entry) => entry.token !== token),
                    );
                    return;
                }
                const confirmedBy = refreshFolderBase();
                setFolderEdits((edits) =>
                    edits.map((entry) =>
                        entry.token === token
                            ? {
                                  ...entry,
                                  confirmedBy,
                                  apply: confirmedEdit(
                                      folderBase,
                                      outcome.processing,
                                      edit,
                                  ),
                              }
                            : entry,
                    ),
                );
            };
        },
        [folderBase, refreshFolderBase],
    );

    const folderOrganization = useMemo(
        () => applyFolderEdits(folderBase, folderEdits),
        [folderBase, folderEdits],
    );
    const settledAssignments = useMemo(
        () =>
            applyFolderEdits(
                folderBase,
                folderEdits.filter((edit) => edit.confirmedBy !== undefined),
            ).assignments,
        [folderBase, folderEdits],
    );
    return {
        folderBase,
        folderEdits,
        folderOrganization,
        settledAssignments,
        setFolderOrganization,
        trackFolderEdit,
        refreshFolderBase,
    };
}
