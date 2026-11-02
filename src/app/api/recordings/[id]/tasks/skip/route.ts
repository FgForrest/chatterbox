import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors";
import { requireTaskViewer } from "@/lib/tasks/route-helpers";
import { skipTaskReview, touchTaskReview } from "@/lib/tasks/tasks";

type Context = { params: Promise<{ id: string }> };

export const POST = apiHandler<Context>(async (request, context) => {
    const { id } = await (context as Context).params;
    await skipTaskReview(await requireTaskViewer(request), id);
    return NextResponse.json({ skipped: true });
});

export const PATCH = apiHandler<Context>(async (request, context) => {
    const { id } = await (context as Context).params;
    await touchTaskReview(await requireTaskViewer(request), id);
    return NextResponse.json({ changed: true });
});
