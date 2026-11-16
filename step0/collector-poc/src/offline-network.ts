// Test-process guard. Host-level egress auditing remains a separate acceptance step.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

const deny = () => { throw new Error('network_forbidden_in_offline_process'); };
globalThis.fetch = deny;
http.request = deny; http.get = deny;
https.request = deny; https.get = deny;
net.connect = deny; net.createConnection = deny; net.Socket.prototype.connect = deny;
tls.connect = deny;
const denyDns = Object.assign(deny, { __promisify__: deny });
dns.lookup = denyDns; dns.resolve = denyDns;
dns.promises.lookup = deny; dns.promises.resolve = deny;
dgram.createSocket = deny;
syncBuiltinESMExports();
