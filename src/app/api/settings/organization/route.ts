import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireApiSessionActor } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { validTimeZone } from "@/lib/i18n/time-zone";
import { organizationSettingsContext } from "@/lib/settings/organization";

export const GET = apiHandler(async (request: Request) => {
    const { actor, session } = await requireApiSessionActor(request);
    const context = await organizationSettingsContext(actor);
    const [organization] = context.orgUserId
        ? await db
              .select({ timeZone: users.timeZone })
              .from(users)
              .where(eq(users.id, context.orgUserId))
              .limit(1)
        : [];
    return NextResponse.json({
        timeZone: organization?.timeZone ?? null,
        canManage: context.canManage,
        isOrganizationAccount: session.user.id === context.orgUserId,
    });
});

export const PUT = apiHandler(async (request: Request) => {
    const { actor } = await requireApiSessionActor(request);
    const context = await organizationSettingsContext(actor);
    if (!context.orgUserId || !context.canManage) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Organization settings management is required",
            403,
        );
    }
    const parsed = z
        .object({
            timeZone: z
                .string()
                .max(100)
                .refine((value) => validTimeZone(value) !== null)
                .nullable(),
        })
        .strict()
        .safeParse(await request.json());
    if (!parsed.success)
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid timeZone value",
            400,
            { field: "timeZone" },
        );
    const input = parsed.data;
    await db
        .update(users)
        .set({ timeZone: validTimeZone(input.timeZone), updatedAt: new Date() })
        .where(eq(users.id, context.orgUserId));
    return NextResponse.json({ success: true });
});
