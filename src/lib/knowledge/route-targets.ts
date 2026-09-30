/**
 * Reading who or what a request is about: `{personId}` or `{entityId}`,
 * and for a fact's object text too (`{literal}`).
 */

import { AppError, ErrorCode } from "@/lib/errors";
import type { KnowledgeTarget } from "@/lib/knowledge/aliases";
import type { FactObject } from "@/lib/knowledge/facts";

const MAX_ID_LENGTH = 64;

function id(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= MAX_ID_LENGTH
    );
}

/** A person or an entity: exactly one of `personId`, `entityId`. */
export function targetOf(value: unknown, field: string): KnowledgeTarget {
    const node = (value ?? {}) as Record<string, unknown>;
    if (id(node.personId) && node.entityId === undefined) {
        return { personId: node.personId };
    }
    if (id(node.entityId) && node.personId === undefined) {
        return { entityId: node.entityId };
    }
    throw new AppError(
        ErrorCode.INVALID_INPUT,
        "Expected a person or a thing",
        400,
        { field },
    );
}

/** A fact's object: a person, an entity, or text. */
export function objectOf(value: unknown): FactObject {
    const node = (value ?? {}) as Record<string, unknown>;
    if (typeof node.literal === "string") return { literal: node.literal };
    return targetOf(node, "object");
}
