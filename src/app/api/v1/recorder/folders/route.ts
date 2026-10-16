import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import { listFolderOrganization } from "@/lib/folders/folders";
import { isOrgScopeEnabled } from "@/lib/org/config";
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

/** `GET /api/v1/recorder/folders` — writable non-root recording folders. */
export const GET = apiHandler(async (request: Request) => {
    const gate = await gateRecordingSessionRequest(request);
    if (gate.response) return gate.response;

    const organization = await listFolderOrganization(gate.authn.user.id);
    const byId = new Map(
        organization.folders.map((folder) => [folder.id, folder]),
    );
    const data = organization.folders
        .filter(
            (folder) =>
                folder.parentId !== null &&
                (folder.scope === "personal" || isOrgScopeEnabled()),
        )
        .map((folder) => ({
            id: folder.id,
            name: folder.name,
            path: folderPath(folder, byId),
            scope: folder.scope,
        }))
        .sort(
            (left, right) =>
                (left.scope === right.scope
                    ? 0
                    : left.scope === "personal"
                      ? -1
                      : 1) || left.path.localeCompare(right.path),
        );

    return NextResponse.json({ data });
});
