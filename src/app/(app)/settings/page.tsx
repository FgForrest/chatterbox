import { SettingsPageContent } from "@/components/settings/settings-page-content";
import { accessManagementAvailable } from "@/lib/access/service";
import { listUserProviders } from "@/lib/ai/list-providers";
import {
    getSessionActor,
    requireAuth,
    requireCompletedOnboarding,
} from "@/lib/auth-server";
import { env } from "@/lib/env";
import { isMailEnabled } from "@/lib/mail/config";
import { isOrgAccount } from "@/lib/org/config";

export default async function SettingsPage() {
    const session = await requireAuth();
    await requireCompletedOnboarding(session);

    const [providers, orgAccount, actor] = await Promise.all([
        listUserProviders(session.user.id, { includeDisabled: true }),
        isOrgAccount(session.user.id),
        getSessionActor(),
    ]);

    return (
        <SettingsPageContent
            initialProviders={providers}
            isHosted={env.IS_HOSTED}
            isOrgAccount={orgAccount}
            mailEnabled={isMailEnabled() && !orgAccount}
            accessManagement={accessManagementAvailable(actor)}
        />
    );
}
