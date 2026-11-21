import { StorageRangeNotSatisfiableError } from "./errors";
import type { ByteRange, RequestedByteRange } from "./types";

/**
 * Resolves inclusive offsets, returning `null` for a full read.
 * @throws {StorageRangeNotSatisfiableError} If the range is unsatisfiable.
 */
export function resolveByteRange(
    range: RequestedByteRange | null,
    size: number,
): ByteRange | null {
    if (range === null) return null;

    if ("suffixLength" in range) {
        if (range.suffixLength === BigInt(0))
            throw new StorageRangeNotSatisfiableError(size);
        if (size === 0) return null;
        return {
            start: size - Math.min(Number(range.suffixLength), size),
            end: size - 1,
        };
    }

    if (range.start >= size) throw new StorageRangeNotSatisfiableError(size);
    return {
        start: Number(range.start),
        end:
            range.end === null
                ? size - 1
                : Math.min(Number(range.end), size - 1),
    };
}
