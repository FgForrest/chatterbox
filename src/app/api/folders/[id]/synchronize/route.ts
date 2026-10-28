import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import {
    assertExportableFolder,
    assertFolderExportsAvailable,
    assertOwnedFolder,
} from "@/lib/folder-exports/configurations";
import { enqueueExportReconciliation } from "@/lib/folder-exports/jobs";
import { resolveReadableFolder } from "@/lib/folders/folders";

type IdContext = { params: Promise<{ id: string }> };

export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    assertFolderExportsAvailable();
    const { id } = await (context as IdContext).params;
    const access = await resolveReadableFolder(session.user.id, id);
    if (access?.scope === "org" && access.ownerId !== session.user.id) {
        await assertExportableFolder(session.user.id, id);
    } else {
        await assertOwnedFolder(session.user.id, id);
    }
    const { job, created } = await enqueueExportReconciliation(
        session.user.id,
        id,
    );
    return NextResponse.json({ jobId: job.id, created }, { status: 202 });
});
