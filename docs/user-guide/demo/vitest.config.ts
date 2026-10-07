import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = resolve(__dirname, "../../..");

export default defineConfig({
    root,
    resolve: {
        alias: [{ find: "@", replacement: resolve(root, "src") }],
    },
    test: {
        environment: "node",
        include: ["src/lib/demo/user-guide/*.demo.ts"],
    },
});
