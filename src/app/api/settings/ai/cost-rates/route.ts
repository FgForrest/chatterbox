import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { aiCostRates } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";

const rate = z.number().finite().min(0).max(10000).nullable();
const rateInput = z
    .object({
        provider: z.string().trim().min(1).max(100),
        model: z.string().trim().min(1).max(100),
        inputUsdPerMillion: rate,
        outputUsdPerMillion: rate,
        audioUsdPerHour: rate,
    })
    .refine(
        (value) =>
            (value.inputUsdPerMillion !== null &&
                value.outputUsdPerMillion !== null) ||
            value.audioUsdPerHour !== null,
    );

export const GET = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    const rows = await db
        .select()
        .from(aiCostRates)
        .where(eq(aiCostRates.userId, session.user.id));
    return NextResponse.json({ rates: rows });
});

export const PUT = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    const parsed = rateInput.safeParse(await request.json());
    if (!parsed.success) {
        throw new AppError(ErrorCode.INVALID_INPUT, "Invalid AI rate", 400);
    }
    const input = parsed.data;
    const toDecimal = (value: number | null) =>
        value === null ? null : value.toFixed(6);
    const values = {
        inputUsdPerMillion: toDecimal(input.inputUsdPerMillion),
        outputUsdPerMillion: toDecimal(input.outputUsdPerMillion),
        audioUsdPerHour: toDecimal(input.audioUsdPerHour),
        updatedAt: new Date(),
    };
    const [saved] = await db
        .insert(aiCostRates)
        .values({
            userId: session.user.id,
            provider: input.provider,
            model: input.model,
            ...values,
        })
        .onConflictDoUpdate({
            target: [
                aiCostRates.userId,
                aiCostRates.provider,
                aiCostRates.model,
            ],
            set: values,
        })
        .returning();
    return NextResponse.json({ rate: saved });
});

export const DELETE = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    const parsed = z
        .object({ id: z.string().min(1) })
        .safeParse(await request.json());
    if (!parsed.success) {
        throw new AppError(ErrorCode.INVALID_INPUT, "Invalid AI rate", 400);
    }
    await db
        .delete(aiCostRates)
        .where(
            and(
                eq(aiCostRates.id, parsed.data.id),
                eq(aiCostRates.userId, session.user.id),
            ),
        );
    return NextResponse.json({ ok: true });
});
