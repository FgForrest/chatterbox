import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";

const BIG_ZERO = BigInt(0);
const BIG_ONE = BigInt(1);
const BIG_16 = BigInt(16);
const IPV6_UNIQUE_LOCAL_PREFIX = BigInt(0x7e);
const IPV6_LINK_LOCAL_PREFIX = BigInt(0x3fa);
const IPV6_SITE_LOCAL_PREFIX = BigInt(0x3fb);
const IPV6_NAT64_PREFIX = BigInt("0x64ff9b0000000000000000");
const IPV6_6TO4_PREFIX = BigInt(0x2002);
const IPV6_MULTICAST_PREFIX = BigInt(0xff);
const IPV6_DOCUMENTATION_PREFIX = BigInt(0x20010db8);

export type PublicAddress = { address: string; family: 4 | 6 };

export class PublicHostnameResolutionError extends Error {
    constructor(label: string) {
        super(`${label} host could not be resolved`);
        this.name = "PublicHostnameResolutionError";
    }
}

function normalizedHostname(hostname: string): string {
    const lower = hostname.toLowerCase().replace(/\.$/, "");
    if (lower.startsWith("[") && lower.endsWith("]")) {
        return lower.slice(1, -1);
    }
    return lower;
}

function parseIpv4(address: string): [number, number, number, number] | null {
    const parts = address.split(".").map((part) => Number.parseInt(part, 10));
    if (
        parts.length !== 4 ||
        parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
        return null;
    }
    return [parts[0], parts[1], parts[2], parts[3]];
}

function isPrivateIpv4(address: string): boolean {
    const parts = parseIpv4(address);
    if (!parts) return true;

    const [a, b, c] = parts;
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0 && (c === 0 || c === 2)) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113) ||
        a >= 224
    );
}

function mappedIpv4FromIpv6(address: string): string | null {
    const dottedIpv4 = address.includes(".")
        ? address.slice(address.lastIndexOf(":") + 1)
        : null;
    if (dottedIpv4 && parseIpv4(dottedIpv4)) return dottedIpv4;

    const tail = address.startsWith("::ffff:")
        ? address.slice("::ffff:".length)
        : address.startsWith("0:0:0:0:0:ffff:")
          ? address.slice("0:0:0:0:0:ffff:".length)
          : null;
    if (!tail) return null;

    const parts = tail.split(":");
    if (parts.length !== 2) return null;

    const high = Number.parseInt(parts[0], 16);
    const low = Number.parseInt(parts[1], 16);
    if (
        !Number.isInteger(high) ||
        !Number.isInteger(low) ||
        high < 0 ||
        high > 0xffff ||
        low < 0 ||
        low > 0xffff
    ) {
        return null;
    }

    return [
        (high >> 8) & 0xff,
        high & 0xff,
        (low >> 8) & 0xff,
        low & 0xff,
    ].join(".");
}

function ipv6ToBigInt(address: string): bigint | null {
    if (address.includes(".")) {
        const lastColon = address.lastIndexOf(":");
        const parts = parseIpv4(address.slice(lastColon + 1));
        if (!parts) return null;
        address = `${address.slice(0, lastColon + 1)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
    }

    const parts = address.split("::");
    if (parts.length > 2) return null;

    const left = parts[0] ? parts[0].split(":") : [];
    const right = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
    const zeroCount = parts.length === 2 ? 8 - left.length - right.length : 0;
    if (zeroCount < 0) return null;

    const hextets =
        parts.length === 2
            ? [...left, ...Array(zeroCount).fill("0"), ...right]
            : left;
    if (hextets.length !== 8) return null;

    let result = BIG_ZERO;
    for (const hextet of hextets) {
        if (!/^[0-9a-f]{1,4}$/i.test(hextet)) return null;
        const value = Number.parseInt(hextet, 16);
        if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
            return null;
        }
        result = (result << BIG_16) + BigInt(value);
    }
    return result;
}

function isPrivateIpv6(address: string): boolean {
    const normalized = address.toLowerCase().split("%", 1)[0];
    const ip = ipv6ToBigInt(normalized);
    if (ip === null) return true;
    if (ip >> BigInt(118) === IPV6_SITE_LOCAL_PREFIX) return true;

    const embeddedIpv4 =
        ip >> BigInt(32) === IPV6_NAT64_PREFIX
            ? ip & BigInt(0xffffffff)
            : ip >> BigInt(112) === IPV6_6TO4_PREFIX
              ? (ip >> BigInt(80)) & BigInt(0xffffffff)
              : null;
    if (embeddedIpv4 !== null) {
        return isPrivateIpv4(
            [24, 16, 8, 0]
                .map((shift) =>
                    Number((embeddedIpv4 >> BigInt(shift)) & BigInt(0xff)),
                )
                .join("."),
        );
    }
    const mappedIpv4 = mappedIpv4FromIpv6(normalized);
    if (mappedIpv4) return isPrivateIpv4(mappedIpv4);

    return (
        ip === BIG_ZERO ||
        ip === BIG_ONE ||
        ip >> BigInt(121) === IPV6_UNIQUE_LOCAL_PREFIX ||
        ip >> BigInt(118) === IPV6_LINK_LOCAL_PREFIX ||
        ip >> BigInt(120) === IPV6_MULTICAST_PREFIX ||
        ip >> BigInt(96) === IPV6_DOCUMENTATION_PREFIX
    );
}

function isPrivateIpAddress(address: string): boolean {
    const normalized = normalizedHostname(address);
    const ipVersion = isIP(normalized);
    if (ipVersion === 4) return isPrivateIpv4(normalized);
    if (ipVersion === 6) return isPrivateIpv6(normalized);
    return false;
}

export function assertAllowedPublicHostname(
    hostname: string,
    label = "URL",
): void {
    const normalized = normalizedHostname(hostname);
    if (
        normalized === "localhost" ||
        normalized.endsWith(".localhost") ||
        normalized.endsWith(".local") ||
        normalized.endsWith(".internal") ||
        normalized.endsWith(".home.arpa") ||
        normalized.endsWith(".lan") ||
        isPrivateIpAddress(normalized)
    ) {
        throw new Error(`${label} must use a public hostname or IP address`);
    }
}

export async function resolvePublicHostname(
    hostnameInput: string,
    label = "URL",
): Promise<PublicAddress[]> {
    assertAllowedPublicHostname(hostnameInput, label);
    const hostname = normalizedHostname(hostnameInput);
    const ipVersion = isIP(hostname);
    if (ipVersion === 4 || ipVersion === 6) {
        return [{ address: hostname, family: ipVersion }];
    }

    let addresses: Array<{ address: string; family: number }>;
    try {
        addresses = await lookup(hostname, {
            all: true,
            verbatim: true,
        } as const);
    } catch {
        throw new PublicHostnameResolutionError(label);
    }

    if (addresses.length === 0) {
        throw new PublicHostnameResolutionError(label);
    }
    if (addresses.some((address) => isPrivateIpAddress(address.address))) {
        throw new Error(`${label} must resolve to public IP addresses`);
    }

    return addresses.map((address) => ({
        address: address.address,
        family: address.family === 6 ? 6 : 4,
    }));
}

export function createPinnedLookup(addresses: PublicAddress[]): LookupFunction {
    return (_hostname, options, callback) => {
        if (options.all) {
            callback(null, addresses);
            return;
        }

        const family =
            options.family === 4 || options.family === 6
                ? options.family
                : null;
        const selected =
            (family
                ? addresses.find((address) => address.family === family)
                : undefined) ?? addresses[0];
        callback(null, selected.address, selected.family);
    };
}
