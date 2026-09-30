import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    adoptPhrase,
    MAX_TYPE_LABEL_LENGTH,
    mapPhrase,
    rejectPhrase,
} from "@/lib/knowledge/vocabulary";

type ProposalContext = { params: Promise<{ id: string }> };

const typeKey = z.string().min(1).max(64);
const bodySchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("reject") }),
    z.object({ action: z.literal("map"), key: typeKey }),
    z.object({
        action: z.literal("create"),
        spec: z.object({
            label: z
                .string()
                .trim()
                .min(1)
                .max(MAX_TYPE_LABEL_LENGTH)
                .optional(),
            subjectTypes: z.array(typeKey).min(1).max(20),
            objectTypes: z.array(typeKey).max(20),
            objectKind: z.enum(["entity", "literal"]),
            cardinality: z.enum(["one", "many"]),
        }),
    }),
]);

/**
 * The organization account decides a relation phrase members suggested
 * (Phase 6): `{action: "create", spec}` makes it an Organization relation,
 * `{action: "map", key}` points it at one the Organization or the core
 * has, `{action: "reject"}` declines it. Anyone else: 403.
 */
export const POST = apiHandler<ProposalContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as ProposalContext).params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid request body",
            400,
            { issues: parsed.error.flatten() },
        );
    }
    const body = parsed.data;
    if (body.action === "reject") {
        await rejectPhrase(session.user.id, id);
        return NextResponse.json({ status: "rejected" });
    }
    if (body.action === "map") {
        await mapPhrase(session.user.id, id, body.key);
        return NextResponse.json({ status: "adopted", key: body.key });
    }
    if (
        body.spec.objectKind === "entity" &&
        body.spec.objectTypes.length === 0
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "A relation between things names the types it relates",
            400,
            { field: "objectTypes" },
        );
    }
    const key = await adoptPhrase(session.user.id, id, body.spec);
    return NextResponse.json({ status: "adopted", key });
});
