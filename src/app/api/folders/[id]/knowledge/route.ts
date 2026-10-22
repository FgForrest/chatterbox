import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    FOLDER_KNOWLEDGE_TABS,
    type FolderKnowledgeTab,
    readFolderKnowledge,
} from "@/lib/knowledge/folder-knowledge";

type IdContext = { params: Promise<{ id: string }> };

export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const params = new URL(request.url).searchParams;
    const tab = params.get("tab") ?? "people";
    const offset = Number(params.get("offset") ?? 0);
    const language = params.get("language");
    if (
        !FOLDER_KNOWLEDGE_TABS.includes(tab as FolderKnowledgeTab) ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > 100_000 ||
        (language !== null &&
            !/^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8})*$/.test(language))
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid knowledge tab, offset or language",
            400,
        );
    }
    return NextResponse.json(
        await readFolderKnowledge(
            session.user.id,
            id,
            tab as FolderKnowledgeTab,
            offset,
            language,
        ),
        {
            headers: { "Cache-Control": "private, no-store" },
        },
    );
});
