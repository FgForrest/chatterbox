import { env } from "@/lib/env";

/** Whether an address routes inbound mail on this instance's exact mail domain. */
export function isInternalMailAddress(address: string): boolean {
    if (!env.MAIL_DOMAIN) return false;
    const normalized = address.trim();
    const at = normalized.lastIndexOf("@");
    return (
        at > 0 &&
        normalized.slice(at + 1).toLowerCase() === env.MAIL_DOMAIN.toLowerCase()
    );
}
