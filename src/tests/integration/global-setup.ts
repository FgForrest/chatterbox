import { createTestDatabaseTemplate, getTestDatabaseUrl } from "./postgres";

export default async function setup() {
    const adminUrl = getTestDatabaseUrl();
    if (!adminUrl) return;

    const template = await createTestDatabaseTemplate(adminUrl);
    process.env.VITEST_DATABASE_TEMPLATE = template.name;

    return async () => {
        delete process.env.VITEST_DATABASE_TEMPLATE;
        await template.dispose();
    };
}
