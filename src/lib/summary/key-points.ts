/** Parse one key point per line, stripping one optional list marker and empty lines. */
export function parseKeyPoints(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((line) =>
            line
                .trim()
                .replace(/^[-*•](?: |$)/, "")
                .trim(),
        )
        .filter(Boolean);
}
