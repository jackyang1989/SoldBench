import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const path = typeof first === "string" ? first : first?.path;
  const host =
    typeof first === "number" ? (typeof args[1] === "string" ? args[1] : "localhost") : first?.host;
  const socketAllowed =
    process.env.SOLDBENCH_TEST_SOCKET &&
    typeof path === "string" &&
    path.startsWith(`${process.env.SOLDBENCH_TEST_SOCKET}/`);
  if (!socketAllowed && !localHosts.has(host)) throw new Error("external_network_forbidden_in_tests");
  return originalConnect.apply(this, args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!localHosts.has(url.hostname)) throw new Error("external_network_forbidden_in_tests");
  return originalFetch(input, options);
};
const originalLookup = dns.lookup;
dns.lookup = function (hostname, ...rest) {
  if (!localHosts.has(hostname)) throw new Error("external_network_forbidden_in_tests");
  return originalLookup.call(this, hostname, ...rest);
};
dns.resolve = () => {
  throw new Error("external_network_forbidden_in_tests");
};
dns.promises.lookup = async (hostname) => {
  if (!localHosts.has(hostname)) throw new Error("external_network_forbidden_in_tests");
  return { address: hostname === "localhost" ? "127.0.0.1" : hostname, family: hostname === "::1" ? 6 : 4 };
};
dns.promises.resolve = async () => {
  throw new Error("external_network_forbidden_in_tests");
};
syncBuiltinESMExports();
