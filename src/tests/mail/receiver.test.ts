import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodemailer from "nodemailer";
import type { SMTPServer } from "smtp-server";
import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { parseTrustedProxies } from "@/lib/mail/receiver/proxy";
import { createReceiver } from "@/lib/mail/receiver/receiver";
import { AllowedSources, spfRanges } from "@/lib/mail/receiver/sources";
import {
    rawMessage,
    signMessage,
    testResolver,
    testSigner,
} from "@/tests/mail/dkim-fixtures";

const company = testSigner("company.example");
const SECRET = "s".repeat(40);

interface AppCall {
    path: string;
    headers: IncomingMessage["headers"];
    body: Buffer;
}

describe("the mail receiver over real SMTP sessions", () => {
    let app: Server;
    let appUrl = "";
    let spool = "";
    const calls: AppCall[] = [];
    let answer: (call: AppCall) => { status: number; body: unknown } = () => ({
        status: 200,
        body: {},
    });
    let receiver: SMTPServer | null = null;
    let port = 0;
    const logs: Record<string, unknown>[] = [];
    const sockets: Socket[] = [];

    beforeAll(async () => {
        spool = mkdtempSync(join(tmpdir(), "riffado-spool-"));
        app = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                const call = {
                    path: request.url ?? "",
                    headers: request.headers,
                    body: Buffer.concat(chunks),
                };
                calls.push(call);
                const { status, body } = answer(call);
                response.writeHead(status, {
                    "content-type": "application/json",
                });
                response.end(JSON.stringify(body));
            });
        });
        await new Promise<void>((resolve) =>
            app.listen(0, "127.0.0.1", resolve),
        );
        appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await new Promise((resolve) => app.close(resolve));
        rmSync(spool, { recursive: true, force: true });
    });

    afterEach(async () => {
        calls.length = 0;
        logs.length = 0;
        for (const socket of sockets.splice(0)) socket.destroy();
        if (receiver) {
            const closing = receiver;
            receiver = null;
            await new Promise<void>((resolve) =>
                closing.close(() => resolve()),
            );
        }
    });

    async function start(
        options: {
            sources?: string;
            maxBytes?: number;
            trustedProxies?: string;
            maxConnectionsPerIp?: number;
        } = {},
    ) {
        const sources = new AllowedSources(
            options.sources ?? "127.0.0.1/32,::1/128",
        );
        await sources.refresh();
        receiver = createReceiver({
            domain: "klepna.example",
            hostname: "mx.klepna.example",
            ingestUrl: appUrl,
            ingestSecret: SECRET,
            maxMessageBytes: options.maxBytes ?? 1024 * 1024,
            sources,
            trustedProxies: parseTrustedProxies(options.trustedProxies),
            maxConnectionsPerIp: options.maxConnectionsPerIp,
            spoolDir: spool,
            resolver: testResolver([company]),
            appTimeoutMs: 5_000,
            log: (entry) => logs.push(entry),
        });
        await new Promise<void>((resolve) =>
            receiver?.listen(0, "127.0.0.1", () => resolve()),
        );
        port = (receiver.server.address() as AddressInfo).port;
    }

    function client() {
        return nodemailer.createTransport({
            host: "127.0.0.1",
            port,
            secure: false,
            ignoreTLS: true,
            tls: { rejectUnauthorized: false },
        });
    }

    async function signed(to = "jan@klepna.example") {
        return signMessage(
            rawMessage(
                [
                    "From: jan@company.example",
                    `To: ${to}`,
                    "Subject: Hello",
                    "Date: Fri, 09 Oct 2026 14:02:00 +0200",
                    "Message-ID: <r1@company.example>",
                ],
                "Body text.",
            ),
            company,
        );
    }

    async function send(raw: Buffer, to: string[]) {
        return client().sendMail({
            envelope: { from: "jan@company.example", to },
            raw,
        });
    }

    /** A client whose connection starts with `header`, as a proxy's does. */
    function proxiedClient(header: string) {
        return nodemailer.createTransport({
            host: "127.0.0.1",
            port,
            secure: false,
            ignoreTLS: true,
            getSocket: (_options, callback) => {
                const socket = connect(port, "127.0.0.1", () => {
                    socket.write(header);
                    callback(null, { connection: socket });
                });
                sockets.push(socket);
            },
        });
    }

    function rawConnection(header: string): Socket {
        const socket = connect(port, "127.0.0.1", () => {
            if (header) socket.write(header);
        });
        socket.setEncoding("utf8");
        sockets.push(socket);
        return socket;
    }

    /** Opens a raw connection, sends `header`, and reads the first reply line. */
    function open(header = ""): Promise<{ socket: Socket; reply: string }> {
        const socket = rawConnection(header);
        return new Promise((resolve, reject) => {
            let text = "";
            socket.on("error", reject);
            socket.on("data", (chunk: string) => {
                text += chunk;
                const end = text.indexOf("\r\n");
                if (end >= 0) resolve({ socket, reply: text.slice(0, end) });
            });
            socket.on("close", () => resolve({ socket, reply: text }));
        });
    }

    /** Everything the receiver says on a raw connection until it closes it. */
    function transcript(header = ""): Promise<string> {
        const socket = rawConnection(header);
        return new Promise((resolve, reject) => {
            let text = "";
            socket.on("error", reject);
            socket.on("data", (chunk: string) => {
                text += chunk;
            });
            socket.on("close", () => resolve(text));
        });
    }

    it("prechecks with metadata, then hands the raw message over, and answers 250", async () => {
        answer = (call) =>
            call.path.endsWith("/precheck")
                ? { status: 200, body: { accepted: ["jan@klepna.example"] } }
                : { status: 200, body: { outcomes: [], overQuota: false } };
        await start();
        const raw = await signed();
        const info = await send(raw, ["jan@klepna.example"]);
        expect(info.accepted).toEqual(["jan@klepna.example"]);
        expect(calls.map((call) => call.path)).toEqual([
            "/api/internal/mail/precheck",
            "/api/internal/mail/ingest",
        ]);
        const precheck = JSON.parse(calls[0]?.body.toString() ?? "{}");
        expect(precheck.recipients).toEqual(["jan@klepna.example"]);
        expect(precheck.facts.dkim[0]).toMatchObject({
            domain: "company.example",
            result: "pass",
        });
        const ingest = calls[1];
        expect(ingest?.headers.authorization).toBe(`Bearer ${SECRET}`);
        expect(ingest?.headers["x-mail-sha256"]).toBe(
            createHash("sha256")
                .update(ingest?.body ?? Buffer.alloc(0))
                .digest("hex"),
        );
        expect(Number(ingest?.headers["content-length"])).toBe(
            ingest?.body.length,
        );
        expect(ingest?.body.toString()).toContain("Body text.");
        expect(JSON.stringify(logs)).not.toContain("jan@");
    });

    it("never sends the message when no recipient would pass, and still answers 250", async () => {
        answer = () => ({ status: 200, body: { accepted: [] } });
        await start();
        const info = await send(await signed(), ["jan@klepna.example"]);
        expect(info.accepted).toEqual(["jan@klepna.example"]);
        expect(calls.map((call) => call.path)).toEqual([
            "/api/internal/mail/precheck",
        ]);
    });

    it("refuses to relay to other domains at RCPT", async () => {
        answer = () => ({ status: 200, body: { accepted: [] } });
        await start();
        await expect(
            send(await signed(), ["someone@elsewhere.example"]),
        ).rejects.toMatchObject({ responseCode: 550 });
        expect(calls).toEqual([]);
    });

    it("answers 451 when the app fails, so the sender retries", async () => {
        answer = (call) =>
            call.path.endsWith("/precheck")
                ? { status: 200, body: { accepted: ["jan@klepna.example"] } }
                : { status: 503, body: {} };
        await start();
        await expect(
            send(await signed(), ["jan@klepna.example"]),
        ).rejects.toMatchObject({ responseCode: 451 });
    });

    it("answers 452 when an owner is over their daily limit", async () => {
        answer = (call) =>
            call.path.endsWith("/precheck")
                ? { status: 200, body: { accepted: ["jan@klepna.example"] } }
                : { status: 200, body: { outcomes: [], overQuota: true } };
        await start();
        await expect(
            send(await signed(), ["jan@klepna.example"]),
        ).rejects.toMatchObject({ responseCode: 452 });
    });

    it("refuses a message over the size limit with 552, without calling the app", async () => {
        answer = () => ({
            status: 200,
            body: { accepted: ["jan@klepna.example"] },
        });
        await start({ maxBytes: 2048 });
        const big = Buffer.from(
            rawMessage(
                [
                    "From: jan@company.example",
                    "To: jan@klepna.example",
                    "Subject: big",
                ],
                "x".repeat(10_000),
            ),
        );
        await expect(send(big, ["jan@klepna.example"])).rejects.toMatchObject({
            responseCode: 552,
        });
        expect(calls).toEqual([]);
    });

    it("refuses connections from anywhere but the allowed sources", async () => {
        await start({ sources: "192.0.2.0/24" });
        await expect(
            send(await signed(), ["jan@klepna.example"]),
        ).rejects.toThrow();
        expect(calls).toEqual([]);
        expect(logs).toContainEqual({
            event: "connect",
            verdict: "source_refused",
        });
    });

    it("frees a per-address slot only for a connection it counted", async () => {
        await start({ maxConnectionsPerIp: 1 });
        const first = await open();
        expect(first.reply).toMatch(/^220 /);
        expect((await open()).reply).toMatch(/^421 /);
        expect((await open()).reply).toMatch(/^421 /);
        first.socket.destroy();
        await vi.waitFor(async () => {
            expect((await open()).reply).toMatch(/^220 /);
        });
    });

    describe("behind a proxy sending the PROXY protocol", () => {
        const header = (source: string, sourcePort = 40000) =>
            `PROXY TCP4 ${source} 127.0.0.1 ${sourcePort} 25\r\n`;

        it("checks the client the header names and delivers as for a direct one", async () => {
            answer = (call) =>
                call.path.endsWith("/precheck")
                    ? {
                          status: 200,
                          body: { accepted: ["jan@klepna.example"] },
                      }
                    : { status: 200, body: { outcomes: [], overQuota: false } };
            await start({
                sources: "192.0.2.0/24",
                trustedProxies: "127.0.0.1",
            });
            const info = await proxiedClient(header("192.0.2.10")).sendMail({
                envelope: {
                    from: "jan@company.example",
                    to: ["jan@klepna.example"],
                },
                raw: await signed(),
            });
            expect(info.accepted).toEqual(["jan@klepna.example"]);
            expect(calls.map((call) => call.path)).toEqual([
                "/api/internal/mail/precheck",
                "/api/internal/mail/ingest",
            ]);
        });

        it.each([
            ["2001:db8::/32", "2001:db8::10"],
            ["192.0.2.0/24", "::ffff:192.0.2.10"],
        ])("checks a TCP6 header's client against %s", async (sources, client) => {
            await start({ sources, trustedProxies: "127.0.0.1" });
            const { reply } = await open(
                `PROXY TCP6 ${client} 2001:db8::1 40000 25\r\n`,
            );
            expect(reply).toMatch(/^220 /);
        });

        it("refuses a client outside the allowed sources though the proxy is inside them", async () => {
            await start({ trustedProxies: "127.0.0.1" });
            expect(await transcript(header("198.51.100.7"))).toMatch(/^554 /);
            expect(calls).toEqual([]);
            expect(logs).toContainEqual({
                event: "connect",
                verdict: "source_refused",
            });
        });

        it("closes a connection from the proxy that starts without the header, unanswered", async () => {
            await start({ trustedProxies: "127.0.0.1" });
            const said = await transcript("EHLO mail.example\r\n");
            expect(said).not.toMatch(/^\d{3}/m);
            expect(calls).toEqual([]);
        });

        it("expects no header from a peer that is not a trusted proxy", async () => {
            answer = () => ({ status: 200, body: { accepted: [] } });
            await start({ trustedProxies: "203.0.113.1" });
            const info = await send(await signed(), ["jan@klepna.example"]);
            expect(info.accepted).toEqual(["jan@klepna.example"]);
            expect(calls.map((call) => call.path)).toEqual([
                "/api/internal/mail/precheck",
            ]);
        });

        it("counts connections per client, not per proxy", async () => {
            await start({
                sources: "192.0.2.0/24",
                trustedProxies: "127.0.0.1",
                maxConnectionsPerIp: 1,
            });
            const first = await open(header("192.0.2.10", 40001));
            const other = await open(header("192.0.2.11", 40002));
            expect(first.reply).toMatch(/^220 /);
            expect(other.reply).toMatch(/^220 /);
            expect((await open(header("192.0.2.10", 40003))).reply).toMatch(
                /^421 /,
            );
        });
    });
});

describe("trusted proxies", () => {
    it("takes plain IP addresses, an IPv4 one also in its mapped IPv6 form", () => {
        expect(
            parseTrustedProxies(" 203.0.113.10 , ,2001:DB8:0:0::1,"),
        ).toEqual(["203.0.113.10", "::ffff:203.0.113.10", "2001:db8::1"]);
    });

    it("reads a mapped IPv6 entry as the IPv4 address it maps, once", () => {
        expect(
            parseTrustedProxies(
                "::FFFF:cb00:710a,203.0.113.10,::ffff:203.0.113.10",
            ),
        ).toEqual(["203.0.113.10", "::ffff:203.0.113.10"]);
    });

    it("trusts nobody when unset or empty", () => {
        expect(parseTrustedProxies(undefined)).toEqual([]);
        expect(parseTrustedProxies(" , ")).toEqual([]);
    });

    it.each([
        "*",
        "203.0.113.0/24",
        "2001:db8::/32",
        "proxy.example",
        "203.0.113",
        "010.0.0.1",
        "fe80::1%eth0",
        "PROXY TCP4",
    ])("refuses %s", (entry) => {
        expect(() => parseTrustedProxies(`203.0.113.10,${entry}`)).toThrow(
            `not a plain IP address: ${entry}`,
        );
    });
});

describe("allowed sources", () => {
    it("follows SPF includes to Google's sending ranges", async () => {
        const records: Record<string, string[][]> = {
            "_spf.google.com": [
                [
                    "v=spf1 include:_netblocks.google.com include:_netblocks2.google.com ~all",
                ],
            ],
            "_netblocks.google.com": [
                ["v=spf1 ip4:209.85.128.0/17 ip4:74.125.0.0/16 ~all"],
            ],
            "_netblocks2.google.com": [["v=spf1 ip6:2001:4860:4000::/36 ~all"]],
        };
        const resolve = async (name: string) => records[name] ?? [];
        expect(await spfRanges("_spf.google.com", resolve)).toEqual([
            "209.85.128.0/17",
            "74.125.0.0/16",
            "2001:4860:4000::/36",
        ]);
        const sources = new AllowedSources("google", resolve);
        expect(sources.allows("209.85.220.41")).toBe(false);
        await sources.refresh();
        expect(sources.allows("209.85.220.41")).toBe(true);
        expect(sources.allows("::ffff:74.125.1.2")).toBe(true);
        expect(sources.allows("2001:4860:4000::1")).toBe(true);
        expect(sources.allows("198.51.100.7")).toBe(false);
    });

    it("keeps the previous ranges when a refresh fails", async () => {
        let fail = false;
        const sources = new AllowedSources("google", async () => {
            if (fail) throw new Error("dns down");
            return [["v=spf1 ip4:192.0.2.0/24 -all"]];
        });
        await sources.refresh();
        fail = true;
        await expect(sources.refresh()).rejects.toThrow("dns down");
        expect(sources.allows("192.0.2.10")).toBe(true);
    });
});
