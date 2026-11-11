"use client";

import { useExtracted } from "next-intl";
import { useCallback, useRef } from "react";
import { useFolderRefusal } from "@/hooks/use-folder-refusal";
import { parseApiError } from "@/lib/api-errors";

export class FolderRequestError extends Error {
    constructor(
        message: string,
        readonly code: string,
        readonly status: number,
    ) {
        super(message);
    }
}

/** Authenticated restricted-folder requests with localized refusals. */
export function useRestrictedFolderRequest() {
    const i18n = useExtracted();
    const refusal = useFolderRefusal();
    async function perform<T>(
        path: string,
        method = "GET",
        body?: unknown,
    ): Promise<T> {
        const response = await fetch(path, {
            method,
            ...(body !== undefined
                ? {
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(body),
                  }
                : {}),
        });
        if (!response.ok) {
            const error = await parseApiError(response);
            throw new FolderRequestError(
                response.status === 429
                    ? i18n("Too many requests. Please try again shortly.")
                    : (refusal(error) ??
                          i18n("Could not update folder. Please try again.")),
                error.code,
                response.status,
            );
        }
        return response.json() as Promise<T>;
    }
    const current = useRef(perform);
    current.current = perform;
    return useCallback(function request<T>(
        path: string,
        method = "GET",
        body?: unknown,
    ): Promise<T> {
        return current.current<T>(path, method, body);
    }, []);
}
