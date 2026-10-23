import type { ReactNode } from "react";
import { AlmanacTabs } from "@/components/almanac/almanac-tabs";
import { AppHeader } from "@/components/app-header";
import { requireAuth } from "@/lib/auth-server";
import { canOpenCare } from "@/lib/knowledge/care-access";
import { careCount } from "@/lib/knowledge/care-summary";

/**
 * The Almanac: the people and things Riffado knows, the vocabulary it
 * knows them by, and the reviews waiting for the viewer. One header
 * and one row of tabs for all of its pages.
 */
export default async function AlmanacLayout({
    children,
}: {
    children: ReactNode;
}) {
    const session = await requireAuth();
    const canCurate = await canOpenCare(session.user.id);
    const count = canCurate ? await careCount(session.user.id) : 0;
    return (
        <div className="container mx-auto max-w-7xl px-4 py-6">
            <AppHeader />
            <AlmanacTabs canCurate={canCurate} careCount={count} />
            {children}
        </div>
    );
}
