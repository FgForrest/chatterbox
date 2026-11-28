import {
    createPrivateKey,
    createPublicKey,
    diffieHellman,
    generateKeyPairSync,
    hkdfSync,
} from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recorderOfflineKeys } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/encryption";
import { AppError, ErrorCode } from "@/lib/errors";

export type SealedCapture = {
    protocol: 2;
    kid: string;
    ephemeralPublicKey: string;
    salt: string;
};

const OFFLINE_KEY_ALGORITHM = "ECDH-P256-HKDF-SHA256-A256GCM";

/** Return the caller's current public key, creating one if necessary. */
export async function getOrCreateRecorderOfflineKey(userId: string) {
    const active = () =>
        db
            .select({
                kid: recorderOfflineKeys.id,
                publicKey: recorderOfflineKeys.publicKey,
            })
            .from(recorderOfflineKeys)
            .where(
                and(
                    eq(recorderOfflineKeys.userId, userId),
                    isNull(recorderOfflineKeys.retiredAt),
                ),
            )
            .limit(1);
    let [key] = await active();
    if (!key) {
        const pair = generateKeyPairSync("ec", {
            namedCurve: "prime256v1",
            publicKeyEncoding: { type: "spki", format: "der" },
            privateKeyEncoding: { type: "pkcs8", format: "der" },
        });
        [key] = await db
            .insert(recorderOfflineKeys)
            .values({
                userId,
                publicKey: pair.publicKey.toString("base64url"),
                privateKey: encrypt(pair.privateKey.toString("base64url")),
            })
            .onConflictDoNothing()
            .returning({
                kid: recorderOfflineKeys.id,
                publicKey: recorderOfflineKeys.publicKey,
            });
        if (!key) [key] = await active();
    }
    if (!key)
        throw new Error("Could not resolve the active offline recorder key");
    return { ...key, alg: OFFLINE_KEY_ALGORITHM };
}

function canonicalBase64Url(value: unknown, bytes: number): value is string {
    if (
        typeof value !== "string" ||
        value.length !== Math.ceil((bytes * 4) / 3)
    )
        return false;
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === bytes && decoded.toString("base64url") === value;
}

/** Parse the public protocol 2 descriptor before resolving its recipient. */
export function parseSealedCapture(value: unknown): SealedCapture {
    if (value && typeof value === "object") {
        const { protocol, kid, ephemeralPublicKey, salt } = value as Record<
            string,
            unknown
        >;
        if (
            protocol === 2 &&
            typeof kid === "string" &&
            /^[A-Za-z0-9_-]{1,64}$/.test(kid) &&
            !/\s/.test(kid) &&
            canonicalBase64Url(ephemeralPublicKey, 65) &&
            canonicalBase64Url(salt, 16) &&
            Buffer.from(ephemeralPublicKey, "base64url")[0] === 4
        ) {
            return { protocol, kid, ephemeralPublicKey, salt };
        }
    }
    throw new AppError(
        ErrorCode.INVALID_INPUT,
        "Invalid sealed recording descriptor",
        400,
        {
            field: "encryption",
        },
    );
}

/** Derive the existing v1 chunk key from a P-256 recipient and capture descriptor. */
export function deriveSealedCaptureKey(
    recipientPrivateKey: Buffer,
    capture: SealedCapture,
    clientRecordingId: string,
): Buffer {
    const privateKey = createPrivateKey({
        key: recipientPrivateKey,
        type: "pkcs8",
        format: "der",
    });
    const point = Buffer.from(capture.ephemeralPublicKey, "base64url");
    let secret: Buffer;
    try {
        const publicKey = createPublicKey({
            format: "jwk",
            key: {
                kty: "EC",
                crv: "P-256",
                x: point.subarray(1, 33).toString("base64url"),
                y: point.subarray(33).toString("base64url"),
            },
        });
        secret = diffieHellman({ privateKey, publicKey });
    } catch {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid P-256 recorder point",
            400,
            {
                field: "encryption.ephemeralPublicKey",
            },
        );
    }
    return Buffer.from(
        hkdfSync(
            "sha256",
            secret,
            Buffer.from(capture.salt, "base64url"),
            `chatterbox-recorder-offline-v1:${capture.kid}:${clientRecordingId}`,
            32,
        ),
    );
}

/** Resolve the recipient by owner and kid. Retiring a key preserves sealed uploads. */
export async function resolveSealedCaptureKey(
    executor: Pick<typeof db, "select">,
    userId: string,
    clientRecordingId: string,
    capture: SealedCapture,
): Promise<Buffer> {
    const [recipient] = await executor
        .select({ privateKey: recorderOfflineKeys.privateKey })
        .from(recorderOfflineKeys)
        .where(
            and(
                eq(recorderOfflineKeys.userId, userId),
                eq(recorderOfflineKeys.id, capture.kid),
            ),
        )
        .limit(1);
    if (!recipient) {
        throw new AppError(
            ErrorCode.OFFLINE_KEY_UNAVAILABLE,
            "Offline recorder key is unavailable for this account",
            410,
        );
    }
    return deriveSealedCaptureKey(
        Buffer.from(decrypt(recipient.privateKey), "base64url"),
        capture,
        clientRecordingId,
    );
}
