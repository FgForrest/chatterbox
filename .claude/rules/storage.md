---
paths:
  - "src/lib/storage/**"
---

# Storage adapters

Storage is pluggable behind `StorageProvider` (`src/lib/storage/types.ts`) and configured at the
**instance level** (env vars), not per user. Don't branch on storage type anywhere outside
`src/lib/storage/factory.ts`.

## Adding a storage adapter

1. Implement `StorageProvider`: `uploadFile`, `downloadFile`, `getSignedUrl`, `deleteFile`,
   `testConnection`.
2. Add your adapter class in `src/lib/storage/<name>.ts`.
3. Add the new type to the `StorageType` union in `types.ts`.
4. Add a branch in `createStorageProvider()` in `factory.ts`.
5. Add any new env vars following `.claude/rules/deploy-surface.md` (`src/lib/env.ts`,
   `.env.example`, `docker-compose.yml`, docs).
6. Validate required env vars in the factory and throw a helpful error if missing (see the S3
   branch for the pattern).
7. Add a settings UI section if the adapter has per-user-visible config (S3 does; Local doesn't).

S3 credentials are encrypted at rest (`AGENTS.md`, Encryption at rest).
