import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    MAX_CATEGORIZATION_FOLDERS,
    resolveCategorizationSelection,
} from "@/lib/pipeline/categorization";
import { serializeProcessingResolution } from "@/lib/pipeline/categorization-presentation";

type IdContext = { params: Promise<{ id: string }> };

const previewSchema = z
    .object({
        folderIds: z
            .array(z.string().min(1))
            .min(1)
            .max(MAX_CATEGORIZATION_FOLDERS),
    })
    .strict();

export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id: itemId } = await (context as IdContext).params;
    const parsed = previewSchema.safeParse(
        await request.json().catch(() => null),
    );
    if (!parsed.success) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid request body",
            400,
            { issues: parsed.error.issues },
        );
    }
    const { resolution } = await resolveCategorizationSelection({
        ownerUserId: session.user.id,
        itemId,
        folderIds: parsed.data.folderIds,
        seedProfiles: false,
    });
    return NextResponse.json({
        resolution: serializeProcessingResolution(resolution),
    });
});
