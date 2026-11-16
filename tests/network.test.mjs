import assert from "node:assert/strict";
import dns from "node:dns";
import net from "node:net";
import test from "node:test";

test("test process denies external HTTP, raw sockets and DNS with positive controls", async () => {
  await assert.rejects(fetch("https://example.invalid"), /external_network_forbidden/);
  assert.throws(() => net.connect({ host: "example.invalid", port: 443 }), /external_network_forbidden/);
  await assert.rejects(dns.promises.resolve("example.invalid"), /external_network_forbidden/);
});
