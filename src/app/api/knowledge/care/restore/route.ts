import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { requireCareCurator } from "@/lib/knowledge/care-access";
import {
    CARE_RESTORE_MAX_BYTES,
    careArchiveSchema,
} from "@/lib/knowledge/care-archive";
import { restoreCareArchive } from "@/lib/knowledge/restore-care";
import { jsonBody } from "@/lib/knowledge/route-helpers";

export const POST = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    await requireCareCurator(session.user.id);
    const body = z
        .object({
            archive: careArchiveSchema,
            idMap: z
                .record(z.string().max(64), z.string().min(1).max(64))
                .default({}),
        })
        .safeParse(await jsonBody(request, CARE_RESTORE_MAX_BYTES));
    if (!body.success)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid Care archive",
            400,
        );
    return NextResponse.json(
        await restoreCareArchive(
            session.user.id,
            body.data.archive,
            body.data.idMap,
        ),
    );
});
