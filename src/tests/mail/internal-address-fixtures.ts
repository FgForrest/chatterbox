export const internalMailEnv = {
    IS_HOSTED: false,
    SELF_HOST_MODE: "local" as "local" | "shared",
    MAIL_DOMAIN: "inbound.example.test" as string | undefined,
    MAIL_ORG_NICKNAME: "team",
    MAIL_FORMER_ORG_NICKNAMES: [] as string[],
    MAIL_ADDRESS_HASH_SECRET: "m".repeat(40),
    MAIL_INGEST_SECRET: "i".repeat(40),
    MAIL_INACTIVE_DAYS: 180,
    DEFAULT_STORAGE_TYPE: "local",
    LOCAL_STORAGE_PATH: "",
    ENCRYPTION_KEY:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
    DATABASE_URL: "postgres://unused",
    KNOWLEDGE_MEMORY_MB: 64,
};

export const internalMailDbRef: {
    current: Record<PropertyKey, unknown> | null;
} = { current: null };
export const internalMailDbProxy = new Proxy(
    {},
    {
        get: (_target, property: string | symbol) => {
            const current = internalMailDbRef.current;
            if (!current) throw new Error("test database was not initialized");
            const value = current[property];
            return typeof value === "function" ? value.bind(current) : value;
        },
    },
);
