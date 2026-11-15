import { afterAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { payOnce } from "../client.js";
import { demo } from "../identities.js";
import { localBackend, startServer } from "../server.js";

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

describe("examples (local mode)", () => {
  it("the client pays three inference calls from its position and two escrow calls, and opens every answer", async () => {
    const backend = localBackend();
    const { server, origin } = await startServer(backend, 0);
    servers.push(server);
    const lines: string[] = [];
    const out = await payOnce(origin, demo.payer, backend.memory, (l) => lines.push(l), demo.positionId);

    expect(out.helloText).toBe(`hello ${demo.payer.address}, this answer was paid for and sealed to you`);
    expect(out.echoText).toBe(out.question);
    expect(out.echo.payment?.requestSealed).toBe(true);
    expect(out.inferences).toHaveLength(3);
    expect(JSON.parse(out.inferences[0]!).choices[0].message.content).toContain("characters received");
    const position = await backend.memory.perennialPosition(demo.vault, demo.positionId);
    expect(position.buffer).toBe(10_000n - 3n * 2_000n);
    expect(position.nonce).toBe(3n);
    expect(backend.memory.paidTo(demo.gateway.address)).toBe(3n * 2_000n + 20_000n);
    expect(lines.join("\n")).toContain("verified against its on-chain key");
  });
});
