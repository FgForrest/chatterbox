import { getExtracted } from "next-intl/server";

export default async function CareLoading() {
    const i18n = await getExtracted();
    return (
        <output className="block min-h-40 p-4 text-sm text-muted-foreground">
            {i18n("Loading…")}
        </output>
    );
}
