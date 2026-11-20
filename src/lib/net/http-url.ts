import { AppError, ErrorCode } from "@/lib/errors";

export class InvalidHttpUrlError extends AppError {
    constructor(field: string, allowCredentials: boolean) {
        super(
            ErrorCode.INVALID_INPUT,
            allowCredentials
                ? "Enter a valid absolute URL using HTTP or HTTPS."
                : "Enter a valid absolute URL using HTTP or HTTPS without credentials.",
            400,
            { field },
        );
    }
}

/** Parse an absolute HTTP(S) URL with the caller's credential policy. */
export function requireHttpUrl(
    input: unknown,
    {
        field = "url",
        allowCredentials,
    }: {
        field?: string;
        allowCredentials: boolean;
    },
): URL {
    if (typeof input !== "string") {
        throw new InvalidHttpUrlError(field, allowCredentials);
    }

    let url: URL;
    try {
        url = new URL(input.trim());
    } catch {
        throw new InvalidHttpUrlError(field, allowCredentials);
    }
    if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        (!allowCredentials && (url.username || url.password))
    ) {
        throw new InvalidHttpUrlError(field, allowCredentials);
    }
    return url;
}
