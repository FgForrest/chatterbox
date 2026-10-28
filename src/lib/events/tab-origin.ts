"use client";

import { nanoid } from "nanoid";

let origin: string | undefined;

/** Identify this page load independently of other tabs and reloads. */
export function tabEventOrigin(): string {
    origin ??= nanoid();
    return origin;
}
