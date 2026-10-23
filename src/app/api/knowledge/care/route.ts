import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { fixCareProblem, listCareProblems } from "@/lib/knowledge/care";
import { requireCareCurator } from "@/lib/knowledge/care-access";
import { jsonBody } from "@/lib/knowledge/route-helpers";

export const GET = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    await requireCareCurator(session.user.id);
    const query = z
        .object({
            kind: z
                .enum(["fact_conflict", "correction_conflict", "thin"])
                .default("fact_conflict"),
            offset: z.coerce.number().int().min(0).max(10000).default(0),
        })
        .safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success)
        throw new AppError(ErrorCode.INVALID_INPUT, "Invalid Care query", 400);
    return NextResponse.json(
        await listCareProblems(
            session.user.id,
            query.data.kind,
            query.data.offset,
        ),
    );
});

export const POST = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    await requireCareCurator(session.user.id);
    const body = z
        .object({
            key: z.string().length(64),
            action: z.enum(["dismiss", "keep", "delete"]),
            optionId: z.string().min(1).max(100).optional(),
        })
        .safeParse(await jsonBody(request));
    if (!body.success)
        throw new AppError(ErrorCode.INVALID_INPUT, "Invalid Care action", 400);
    await fixCareProblem(
        session.user.id,
        body.data.key,
        body.data.action,
        body.data.optionId,
    );
    return NextResponse.json({ fixed: true });
});
