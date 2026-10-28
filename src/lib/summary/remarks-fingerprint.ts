import { createHash } from "node:crypto";

/** Fingerprint remark membership to reject results made from an obsolete correction list. */
export function summaryRemarksFingerprint(
    remarks: readonly { id: string }[],
): string {
    return createHash("sha256")
        .update(JSON.stringify(remarks.map((remark) => remark.id)))
        .digest("hex");
}
