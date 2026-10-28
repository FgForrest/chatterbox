import { NextResponse } from "next/server";
import { requireApiSessionActor } from "@/lib/auth-server";
import { actsForOrganization } from "@/lib/authz/curator";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    ITEM_KNOWLEDGE_TABS,
    type ItemKnowledgeTab,
} from "@/lib/knowledge/folder-knowledge";
import { readItemKnowledge } from "@/lib/knowledge/read-item-knowledge";
import { requestedRecordingView } from "@/lib/sharing/access";

type IdContext = { params: Promise<{ id: string }> };

export const GET = apiHandler<IdContext>(async (request, context) => {
    const { session, actor } = await requireApiSessionActor(request);
    const { id } = await (context as IdContext).params;
    const params = new URL(request.url).searchParams;
    const tab = params.get("tab") ?? "people";
    const offset = Number(params.get("offset") ?? 0);
    if (
        !ITEM_KNOWLEDGE_TABS.includes(tab as ItemKnowledgeTab) ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > 100_000
    )
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid knowledge tab or offset",
            400,
        );
    return NextResponse.json(
        await readItemKnowledge(
            session.user.id,
            id,
            requestedRecordingView(request),
            tab as ItemKnowledgeTab,
            offset,
            await actsForOrganization(actor),
        ),
        {
            headers: { "Cache-Control": "private, no-store" },
        },
    );
});
