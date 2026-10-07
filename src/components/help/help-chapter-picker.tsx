"use client";

import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";

/** Moves the help frame to another chapter of the user guide. */
export function HelpChapterPicker({
    chapters,
    current,
}: {
    chapters: { name: string; url: string }[];
    current: string;
}) {
    const i18n = useExtracted();
    const router = useRouter();
    return (
        <div className="sticky top-0 z-10 -mx-5 border-b bg-fd-background/95 px-5 py-2 backdrop-blur">
            <label className="flex items-center gap-2 text-sm text-fd-muted-foreground">
                {i18n("Chapter")}
                <select
                    value={current}
                    onChange={(event) => router.push(event.target.value)}
                    className="min-w-0 flex-1 rounded-md border bg-fd-background px-2 py-1 text-fd-foreground"
                >
                    {chapters.map((chapter) => (
                        <option key={chapter.url} value={chapter.url}>
                            {chapter.name}
                        </option>
                    ))}
                </select>
            </label>
        </div>
    );
}
