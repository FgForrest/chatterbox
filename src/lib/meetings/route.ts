import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { gateRecordingSessionRequest } from "@/lib/recording-sessions/route-gate";

type Context = { params: Promise<Record<string, string>> };
export interface MeetingRequest {
    userId: string;
    params: Record<string, string>;
    url: URL;
    request: Request;
}

/** Common authentication and error boundary for the internal and recorder meeting APIs. */
export function meetingRoute(
    run: (input: MeetingRequest) => Promise<unknown>,
    recorder = false,
) {
    return apiHandler<Context>(async (request, context) => {
        let userId: string;
        if (recorder) {
            const gate = await gateRecordingSessionRequest(request);
            if (gate.response) return gate.response;
            userId = gate.authn.user.id;
        } else userId = (await requireApiSession(request)).user.id;
        try {
            const value = await run({
                userId,
                params: context ? await context.params : {},
                url: new URL(request.url),
                request,
            });
            return value instanceof Response
                ? value
                : NextResponse.json(value ?? { success: true });
        } catch (error) {
            if (error instanceof z.ZodError)
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "Invalid meeting input",
                    400,
                    {
                        issues: error.issues.map((issue) => ({
                            path: issue.path,
                            message: issue.message,
                        })),
                    },
                );
            throw error;
        }
    });
}

/** Validate a bounded ISO date query parameter. */
export function meetingDate(value: string | null, fallback?: Date): Date {
    if (value === null && fallback) return fallback;
    const parsed = z.iso.datetime({ offset: true }).parse(value);
    return new Date(parsed);
}
