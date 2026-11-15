import { afterAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { payOnce } from "../client.js";
import { demo } from "../identities.js";
import { localBackend, startServer } from "../server.js";

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

describe("examples (local mode)", () => {
  it("the client pays the endpoint twice and opens both sealed answers", async () => {
    const backend = localBackend();
    const { server, origin } = await startServer(backend, 0);
    servers.push(server);
    const lines: string[] = [];
    const out = await payOnce(origin, demo.payer, backend.memory, (l) => lines.push(l));

    expect(out.helloText).toBe(`hello ${demo.payer.address}, this answer was paid for and sealed to you`);
    expect(out.echoText).toBe(out.question);
    expect(out.echo.payment?.requestSealed).toBe(true);
    expect(backend.memory.paidTo(demo.gateway.address)).toBe(20_000n);
    expect(lines.join("\n")).toContain("verified against its on-chain key");
  });
});
