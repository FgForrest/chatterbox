import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    restoreRestrictedFolderMetadata,
    restoreWithheldPlacements,
    restrictedFolderArchiveSchema,
    withheldPlacementArchiveSchema,
} from "@/lib/folders/restore-restrictions";

const ids = z
    .record(z.string().max(255), z.string().max(255))
    .refine((map) => Object.keys(map).length <= 1000);
const input = z.discriminatedUnion("scope", [
    z.object({
        scope: z.literal("personal"),
        placements: z.array(withheldPlacementArchiveSchema).max(1000),
        itemIds: ids,
    }),
    z.object({
        scope: z.literal("organization"),
        folders: z.array(restrictedFolderArchiveSchema).max(100),
        folderIds: ids,
    }),
]);
export const POST = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    const parsed = input.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            ErrorCode.INVALID_INPUT,
            400,
        );
    const data = parsed.data;
    return NextResponse.json(
        data.scope === "personal"
            ? await restoreWithheldPlacements(
                  session.user.id,
                  data.placements,
                  data.itemIds,
              )
            : await restoreRestrictedFolderMetadata(
                  session.user.id,
                  data.folders,
                  data.folderIds,
              ),
    );
});
