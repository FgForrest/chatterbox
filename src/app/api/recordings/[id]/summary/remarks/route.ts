import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { aiEnhancements, summaryRemarks } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { ALL_ITEM_KINDS } from "@/lib/content/item-kinds";
import { encryptText } from "@/lib/encryption/fields";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { resolveSelectedProfile } from "@/lib/profiles/resolve";
import { resolveManualItemProfile } from "@/lib/profiles/resolve-manual";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { recordingGone } from "@/lib/sharing/writer";
import {
    assertSummaryOwner,
    readSummaryRemarks,
    withSummaryOwnerWrite,
} from "@/lib/summary/edits";
import { summaryModelFor } from "@/lib/summary/summary-model";

type Context = { params: Promise<{ id: string }> };

async function ownerAccess(request: Request, id: string) {
    const session = await requireApiSession(request);
    const access = await requireRecordingView(
        session.user.id,
        id,
        requestedRecordingView(request),
        { kinds: ALL_ITEM_KINDS },
    );
    assertSummaryOwner(access, session.user.id);
    if (new URL(request.url).searchParams.get("source") === "plaud")
        throw recordingGone();
    return { access, userId: session.user.id };
}

export const GET = apiHandler<Context>(async (request, context) => {
    const { id } = await (context as Context).params;
    const { access, userId } = await ownerAccess(request, id);
    const profileId = new URL(request.url).searchParams.get("profileId");
    const profile = profileId
        ? await resolveSelectedProfile({
              profileId,
              actorUserId: userId,
              view: access.view,
          })
        : await resolveManualItemProfile(id, "private", userId, userId);
    if (!profile || profile.profile.channel !== access.kind)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "The selected profile is unavailable",
            400,
        );
    const model = await summaryModelFor(
        userId,
        profile.settings.steps.summary.provider,
    );
    const remarks = await withSummaryOwnerWrite(access, userId, id, (tx) =>
        readSummaryRemarks(userId, id, tx),
    );
    return NextResponse.json({
        remarks,
        profileName: profile.profile.name,
        model: model.model,
        provider: model.credentials.provider,
    });
});

const remarkBody = z.object({ text: z.string().trim().min(1).max(20_000) });

export const POST = apiHandler<Context>(async (request, context) => {
    const { id } = await (context as Context).params;
    const { access, userId } = await ownerAccess(request, id);
    const parsed = remarkBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid summary remark",
            400,
        );
    const remarks = await withSummaryOwnerWrite(
        access,
        userId,
        id,
        async (tx) => {
            const [summary] = await tx
                .select({ id: aiEnhancements.id })
                .from(aiEnhancements)
                .where(
                    and(
                        eq(aiEnhancements.userId, userId),
                        eq(aiEnhancements.itemId, id),
                        eq(aiEnhancements.source, "riffado"),
                    ),
                )
                .limit(1);
            if (!summary) throw recordingGone();
            await tx.insert(summaryRemarks).values({
                itemId: id,
                userId,
                authorUserId: userId,
                text: encryptText(parsed.data.text),
            });
            return readSummaryRemarks(userId, id, tx);
        },
    );
    return NextResponse.json({ remarks });
});

export const DELETE = apiHandler<Context>(async (request, context) => {
    const { id } = await (context as Context).params;
    const { access, userId } = await ownerAccess(request, id);
    const remarkId = new URL(request.url).searchParams.get("remarkId");
    if (!remarkId)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "A remark id is required",
            400,
        );
    await withSummaryOwnerWrite(access, userId, id, async (tx) => {
        await tx
            .delete(summaryRemarks)
            .where(
                and(
                    eq(summaryRemarks.userId, userId),
                    eq(summaryRemarks.itemId, id),
                    eq(summaryRemarks.id, remarkId),
                ),
            );
    });
    return NextResponse.json({ success: true });
});
