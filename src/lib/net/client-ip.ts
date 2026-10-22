/** Read only the proxy-selected header; XFF's last entry is the proxy's append. */
export function configuredClientIp(
    headers: Headers,
    header: string,
): string | null {
    const value = headers.get(header);
    if (!value) return null;
    const ip =
        header.toLowerCase() === "x-forwarded-for"
            ? value.split(",").at(-1)?.trim()
            : value.trim();
    return ip || null;
}
