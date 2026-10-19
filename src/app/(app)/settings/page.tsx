import { SettingsPageContent } from "@/components/settings/settings-page-content";
import { requireAuth, requireCompletedOnboarding } from "@/lib/auth-server";

export default async function SettingsPage() {
    const session = await requireAuth();
    await requireCompletedOnboarding(session);
    return <SettingsPageContent />;
}
