import { NextResponse } from "next/server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    createFolderCategorizationCheck,
    listRecordingFolderTrees,
} from "@/lib/folders/folders";
import { gateRecordingSessionRequest } from "@/lib/recording-sessions/route-gate";
import type { RecordingFolder } from "@/types/folder";

function folderPath(
    folder: RecordingFolder,
    byId: ReadonlyMap<string, RecordingFolder>,
): string {
    const names = [folder.name];
    const seen = new Set([folder.id]);
    let parentId = folder.parentId;
    while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = byId.get(parentId);
        if (!parent) break;
        names.unshift(parent.name);
        parentId = parent.parentId;
    }
    return names.join(" / ");
}

function searchText(value: string): string {
    return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * `GET /api/v1/recorder/folders` searches writable non-root recording folders.
 * The full list without q or id is kept for older extensions only (0.3.x).
 */
export const GET = apiHandler(async (request: Request) => {
    const gate = await gateRecordingSessionRequest(request);
    if (gate.response) return gate.response;

    const params = new URL(request.url).searchParams;
    if (params.has("q") && params.has("id")) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Provide either q or id, not both",
            400,
        );
    }
    const query = params.get("q")?.trim();
    if (query !== undefined && query.length < 2) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Folder search needs at least 2 characters",
            400,
        );
    }
    const folders = await listRecordingFolderTrees(gate.authn.user.id);
    const check = createFolderCategorizationCheck(gate.authn.user.id);
    const allowed = await Promise.all(
        folders.map(async (folder) => {
            try {
                await check(folder);
                return true;
            } catch (error) {
                if (
                    error instanceof AppError &&
                    (error.statusCode === 400 || error.statusCode === 403)
                )
                    return false;
                throw error;
            }
        }),
    );
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    let data = folders
        .filter((_, index) => allowed[index])
        .map((folder) => ({
            id: folder.receivedFolder?.sourceFolderId ?? folder.id,
            name: folder.name,
            path: folderPath(folder, byId),
            scope: folder.scope,
            ...(folder.receivedFolder ? { sharedWithPeople: true } : {}),
        }));

    if (params.has("id")) {
        data = data.filter((folder) => folder.id === params.get("id"));
        if (data.length === 0)
            throw new AppError(ErrorCode.NOT_FOUND, "Folder not found", 404);
    } else if (query !== undefined) {
        const words = searchText(query).split(/\s+/u);
        const nameMatches = (name: string) =>
            words.every((word) => searchText(name).includes(word));
        data = data
            .filter((folder) =>
                words.every((word) => searchText(folder.path).includes(word)),
            )
            .sort(
                (left, right) =>
                    Number(nameMatches(right.name)) -
                        Number(nameMatches(left.name)) ||
                    left.path.length - right.path.length ||
                    left.path.localeCompare(right.path),
            )
            .slice(0, 20);
    } else {
        // Private folders first, then the Organization's, each by path.
        data.sort(
            (left, right) =>
                Number(left.scope === "org") - Number(right.scope === "org") ||
                left.path.localeCompare(right.path),
        );
    }
    return NextResponse.json({ data });
});
