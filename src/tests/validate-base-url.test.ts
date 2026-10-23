import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    HOSTED_LOCAL_BASE_URL_MESSAGE,
    validateAiBaseUrl,
} from "@/lib/ai/validate-base-url";

vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: true } }));
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup }));

const privateUrls = [
    "http://localhost:1234/v1",
    "http://LOCALHOST/v1",
    "https://localhost",
    "http://localhost.:1234/v1",
    "http://app.localhost/v1",
    "http://127.0.0.1:11434/v1",
    "http://127.1.2.3/v1",
    "http://0.0.0.0:8080/v1",
    "http://[::1]:1234/v1",
    "http://[::]:8080/v1",
    "http://[::ffff:127.0.0.1]:1234/v1",
    "http://10.0.0.1/v1",
    "http://172.16.0.1/v1",
    "http://172.31.255.254/v1",
    "http://192.168.1.10/v1",
    "http://169.254.169.254/v1",
    "http://[fd00:ec2::254]/v1",
    "http://[fc00::1]/v1",
    "http://[fe80::1]/v1",
    "http://[::ffff:10.0.0.1]/v1",
    "http://[::ffff:192.168.0.1]/v1",
    "http://[::ffff:a9fe:a9fe]/v1",
    "http://service.internal/v1",
    "http://service.internal./v1",
    "http://service.local/v1",
    "http://service.lan/v1",
    "http://service.home.arpa/v1",
];

describe("validateAiBaseUrl", () => {
    beforeEach(() => {
        vi.mocked(lookup).mockReset();
        vi.mocked(lookup).mockResolvedValue([
            { address: "8.8.8.8", family: 4 },
        ]);
    });

    it.each([
        null,
        undefined,
        "",
        "   ",
    ])("allows default endpoint %j in both modes", async (url) => {
        for (const isHosted of [false, true])
            await expect(validateAiBaseUrl(url, { isHosted })).resolves.toEqual(
                { ok: true },
            );
        expect(lookup).not.toHaveBeenCalled();
    });

    it.each(privateUrls)("hosted rejects %s", async (url) => {
        await expect(
            validateAiBaseUrl(url, { isHosted: true }),
        ).resolves.toEqual({
            ok: false,
            message: HOSTED_LOCAL_BASE_URL_MESSAGE,
        });
        expect(lookup).not.toHaveBeenCalled();
    });

    it.each([
        ...privateUrls,
        "http://ollama:11434/v1",
        "not a url",
    ])("self-host accepts %s without DNS", async (url) => {
        await expect(
            validateAiBaseUrl(url, { isHosted: false }),
        ).resolves.toEqual({ ok: true });
        expect(lookup).not.toHaveBeenCalled();
    });

    it.each([
        "https://api.example.com/v1",
        "http://localhostfoo.example.com/v1",
        "http://my-localhost.example.com/v1",
        "http://[::ffff:8.8.8.8]/v1",
        "http://128.0.0.1/v1",
        "http://172.15.0.1/v1",
        "http://172.32.0.1/v1",
    ])("hosted accepts public %s", async (url) => {
        await expect(
            validateAiBaseUrl(url, { isHosted: true }),
        ).resolves.toEqual({ ok: true });
    });

    it.each([
        "10.0.0.1",
        "172.20.0.1",
        "192.168.1.10",
        "169.254.169.254",
        "fd00:ec2::254",
        "fe80::1",
        "::ffff:192.168.0.1",
    ])("rejects a public name with a private DNS answer %s", async (address) => {
        vi.mocked(lookup).mockResolvedValue([
            { address: "8.8.8.8", family: 4 },
            { address, family: address.includes(":") ? 6 : 4 },
        ]);
        await expect(
            validateAiBaseUrl("https://api.example.com/v1", { isHosted: true }),
        ).resolves.toEqual({
            ok: false,
            message: HOSTED_LOCAL_BASE_URL_MESSAGE,
        });
    });

    it("rejects unparseable URLs", async () => {
        await expect(
            validateAiBaseUrl("not a url", { isHosted: true }),
        ).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining("valid absolute URL"),
        });
    });
    it.each([
        "file:///etc/passwd",
        "ftp://example.com",
        "https://user:secret@example.com/v1",
    ])("rejects invalid provider URL %s", async (url) => {
        await expect(
            validateAiBaseUrl(url, { isHosted: true }),
        ).resolves.toMatchObject({ ok: false });
    });
    it("rejects unresolved and empty DNS answers", async () => {
        vi.mocked(lookup)
            .mockRejectedValueOnce(new Error("ENOTFOUND"))
            .mockResolvedValueOnce([]);
        for (let i = 0; i < 2; i++)
            await expect(
                validateAiBaseUrl("https://missing.example.com/v1", {
                    isHosted: true,
                }),
            ).resolves.toMatchObject({ ok: false });
    });
});
