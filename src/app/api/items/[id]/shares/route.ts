import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { chatterItems } from "@/db/schema";
import { AppError, apiHandler } from "@/lib/errors";
import { agendaTaskShareDisclosure } from "@/lib/meetings/person-sharing";
import { requirePersonShareSession } from "@/lib/sharing/person-share-routes";
import {
    inviteToItem,
    listItemFolderAudience,
    listItemShares,
} from "@/lib/sharing/person-shares";
import { invalid, readTaskBody } from "@/lib/tasks/route-helpers";

type Context = { params: Promise<{ id: string }> };

export const GET = apiHandler<Context>(async (request, context) => {
    const session = await requirePersonShareSession(request);
    const { id } = await (context as Context).params;
    const [shares, folderAudience, [item]] = await Promise.all([
        listItemShares(session.user.id, id),
        listItemFolderAudience(session.user.id, id),
        db
            .select({ kind: chatterItems.kind })
            .from(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, id),
                    eq(chatterItems.userId, session.user.id),
                ),
            ),
    ]);
    return NextResponse.json({
        shares,
        folderAudience,
        agendaTasks:
            item?.kind === "meeting"
                ? await agendaTaskShareDisclosure(session.user.id, id).catch(
                      (error) => {
                          if (
                              error instanceof AppError &&
                              error.statusCode === 404
                          )
                              return null;
                          throw error;
                      },
                  )
                : null,
    });
});

export const POST = apiHandler<Context>(async (request, context) => {
    const session = await requirePersonShareSession(request);
    const { id } = await (context as Context).params;
    const body = await readTaskBody(request);
    if (
        !Array.isArray(body.receiverIds) ||
        !body.receiverIds.every(
            (id): id is string =>
                typeof id === "string" && id.length > 0 && id.length < 256,
        )
    )
        throw invalid("receiverIds is required");
    return NextResponse.json({
        shares: await inviteToItem(session.user.id, id, body.receiverIds),
    });
});
