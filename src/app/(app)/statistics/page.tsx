import { cookies } from "next/headers";
import { getExtracted } from "next-intl/server";
import { AppHeader } from "@/components/app-header";
import { StatisticsPage } from "@/components/statistics/statistics-page";
import { loadStatistics, statisticsScopes } from "@/db/queries/statistics";
import { requireAuth } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
    const i18n = await getExtracted();
    return { title: i18n("Statistics") };
}

export default async function StatisticsRoute() {
    const session = await requireAuth();
    const scopes = await statisticsScopes();
    const scope = scopes.includes("organization") ? "organization" : "mine";
    const tz = (await cookies()).get("tz")?.value ?? "UTC";
    const data = await loadStatistics(session.user.id, scope, tz);
    return (
        <div className="mx-auto w-full max-w-7xl px-4 pb-8">
            <AppHeader />
            <StatisticsPage initialData={data} scopes={scopes} />
        </div>
    );
}
