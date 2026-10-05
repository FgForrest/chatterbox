import { z } from "zod";
import { AppError, ErrorCode } from "@/lib/errors";

const rate = z.number().finite().min(0).max(10000).nullish();

const rateInput = z
    .object({
        inputUsdPerMillion: rate,
        outputUsdPerMillion: rate,
        audioUsdPerHour: rate,
    })
    .refine(
        (value) =>
            (value.inputUsdPerMillion == null) ===
            (value.outputUsdPerMillion == null),
    );

/**
 * A provider card's price fields from a request body, as `numeric` column
 * values. Absent fields clear the rate. Throws 400 on a negative or
 * non-numeric value, or a token rate without its pair.
 */
export function parseProviderRates(body: unknown): {
    inputUsdPerMillion: string | null;
    outputUsdPerMillion: string | null;
    audioUsdPerHour: string | null;
} {
    const parsed = rateInput.safeParse(body);
    if (!parsed.success) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Enter both token rates, or neither, as non-negative USD amounts.",
            400,
            { field: "pricing" },
        );
    }
    const toDecimal = (value: number | null | undefined) =>
        value == null ? null : value.toFixed(6);
    return {
        inputUsdPerMillion: toDecimal(parsed.data.inputUsdPerMillion),
        outputUsdPerMillion: toDecimal(parsed.data.outputUsdPerMillion),
        audioUsdPerHour: toDecimal(parsed.data.audioUsdPerHour),
    };
}
