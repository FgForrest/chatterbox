/**
 * Which peers may open a connection with a PROXY protocol (v1) header, so
 * that behind a TCP proxy (HAProxy `send-proxy`, nginx `proxy_protocol on`)
 * the receiver sees the client the proxy forwards, not the proxy itself.
 */

import { isIP, SocketAddress } from "node:net";

const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;

/**
 * Parses a comma-separated list of plain IP addresses into the spelling
 * smtp-server compares a peer's address with: Node's own, and for IPv4 also
 * the IPv4-mapped IPv6 form a dual-stack listener reports. Throws on
 * anything else, `*`, ranges and hostnames included.
 */
export function parseTrustedProxies(spec: string | undefined): string[] {
    const peers = new Set<string>();
    for (const entry of (spec ?? "").split(",")) {
        const value = entry.trim();
        if (!value) continue;
        const family = isIP(value);
        if (family === 0 || value.includes("%")) {
            throw new Error(`not a plain IP address: ${value}`);
        }
        const { address } = new SocketAddress({
            address: value,
            family: family === 6 ? "ipv6" : "ipv4",
        });
        const ipv4 = family === 4 ? address : MAPPED_IPV4.exec(address)?.[1];
        if (ipv4) {
            peers.add(ipv4);
            peers.add(`::ffff:${ipv4}`);
        } else {
            peers.add(address);
        }
    }
    return [...peers];
}
