import { z } from "zod";
import { AppError, ErrorCode } from "@/lib/errors";

export const providerMaxOutputTokensSchema = z
    .number()
    .int()
    .min(256)
    .max(200_000)
    .nullish();

/** Validate the optional provider limit without clearing an omitted update. */
export function parseProviderMaxOutputTokens(
    body: unknown,
): number | null | undefined {
    const parsed = z
        .object({ maxOutputTokens: providerMaxOutputTokensSchema })
        .safeParse(body);
    if (!parsed.success) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Max output tokens must be a whole number from 256 to 200,000, or empty.",
            400,
            { field: "maxOutputTokens" },
        );
    }
    return parsed.data.maxOutputTokens;
}
