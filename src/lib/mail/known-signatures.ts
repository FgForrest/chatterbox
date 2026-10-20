import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    chatterItems,
    mailContents,
    mailMessages,
    mailParticipants,
} from "@/db/schema";
import type { ContentSegment, SignatureCue } from "@/lib/content/types";
import { decryptJsonField } from "@/lib/encryption/fields";
import { participantAddressHash } from "@/lib/mail/hash";
import { signatureLines } from "@/lib/mail/signature-patterns";

const TRUSTED_CUES: ReadonlySet<SignatureCue> = new Set([
    "markup",
    "delimiter",
    "closing",
]);

/** Trusted signatures from the last five mails from this From address in this owner's pile. */
export async function knownSignaturesFor(
    ownerUserId: string,
    address: string | null,
    before?: { receivedAt: Date; id: string },
): Promise<string[]> {
    if (!address) return [];
    const rows = await db
        .select({ segments: mailContents.segments })
        .from(mailParticipants)
        .innerJoin(
            mailMessages,
            and(
                eq(mailMessages.id, mailParticipants.itemId),
                eq(mailMessages.userId, ownerUserId),
            ),
        )
        .innerJoin(
            chatterItems,
            and(
                eq(chatterItems.id, mailMessages.id),
                eq(chatterItems.userId, ownerUserId),
            ),
        )
        .leftJoin(
            mailContents,
            and(
                eq(mailContents.itemId, mailMessages.id),
                eq(mailContents.userId, ownerUserId),
            ),
        )
        .where(
            and(
                eq(mailParticipants.userId, ownerUserId),
                eq(
                    mailParticipants.addressHash,
                    participantAddressHash(address),
                ),
                sql`${mailParticipants.roles} @> ${JSON.stringify(["from"])}::jsonb`,
                isNull(mailMessages.deletedAt),
                isNull(chatterItems.deletedAt),
                before
                    ? or(
                          lt(mailMessages.receivedAt, before.receivedAt),
                          and(
                              eq(mailMessages.receivedAt, before.receivedAt),
                              lt(mailMessages.id, before.id),
                          ),
                      )
                    : undefined,
            ),
        )
        .orderBy(desc(mailMessages.receivedAt), desc(mailMessages.id))
        .limit(5);
    return [
        ...new Set(
            rows
                .flatMap((row) =>
                    (decryptJsonField<ContentSegment[]>(row.segments) ?? [])
                        .filter(
                            (segment) =>
                                segment.role === "signature" &&
                                segment.depth === 0 &&
                                segment.signatureCue !== undefined &&
                                TRUSTED_CUES.has(segment.signatureCue),
                        )
                        .map((segment) =>
                            signatureLines(segment.text).join("\n"),
                        ),
                )
                .filter(Boolean),
        ),
    ];
}
