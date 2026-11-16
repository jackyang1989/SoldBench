import { test, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { Store, FixtureTransport, collect, sha } from '../src/collector.ts';

const fixture = () => JSON.parse(readFileSync(new URL('../fixtures/demo.json',import.meta.url),'utf8'));
let networkCalls = 0;
before(() => {
  const denied = () => { networkCalls++; throw new Error('network_forbidden_in_offline_test'); };
  mock.method(globalThis,'fetch',denied);
  for (const client of [http,https]) {mock.method(client,'request',denied);mock.method(client,'get',denied);}
  mock.method(net,'connect',denied);mock.method(net,'createConnection',denied);
  mock.method(net.Socket.prototype,'connect',denied);mock.method(tls,'connect',denied);
});
afterEach(() => {assert.equal(networkCalls,0,'Collector attempted network access');});
after(() => mock.restoreAll());
function setup(t, input=fixture()) {
  const dir=mkdtempSync(join(tmpdir(),'soldbench-collector-test-'));
  let store=new Store(join(dir,'state.json'));
  const transport=new FixtureTransport(input.responses);
  let now=Date.parse(input.asOf);
  const clock={now:()=>now,wait:async ms=>{now+=ms;}};
  const plan={...input.plan,asOf:input.asOf,mode:'offline_fixture',collectorEnabled:false,allowReplay:()=>true};
  const ctx={dir,store,transport,clock,plan,advance:ms=>{now+=ms;},
    run:(patch={})=>collect({...plan,...patch},transport,store,clock),
    reopen:()=>{store.close();store=new Store(join(dir,'state.json'));ctx.store=store;}};
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return ctx;
}
function mutatePage(input,cursor,mutate) {
  const response=input.responses[cursor][0];const page=JSON.parse(response.body);mutate(page);response.body=JSON.stringify(page);
}

test('network blocker positive control rejects fetch, HTTP and raw sockets',()=>{
  assert.throws(()=>fetch('https://example.invalid'),/network_forbidden/);
  assert.throws(()=>http.get('http://example.invalid'),/network_forbidden/);
  assert.throws(()=>net.connect(443,'example.invalid'),/network_forbidden/);
  assert.equal(networkCalls,3);networkCalls=0;
});
test('two pages dedupe events, preserve ambiguous observations, use conservative watermark',async t=>{
  const c=setup(t);const r=await c.run();
  assert.equal(r.outcome,'completed');assert.equal(r.completedPages,2);assert.equal(r.storedCandidateEvents,2);
  assert.equal(r.observations,4);assert.equal(r.quarantined,1);assert.equal(r.dataAsOf,'2026-11-15T23:00:00Z');
  assert.equal(r.onlineVerified,false);assert.equal(r.sourceApproval,'NOT_CLEARED');assert.equal(r.statisticsComputed,false);
  assert.deepEqual(Object.values(c.store.state.events).map(e=>e.record.listingId),['listing-1','listing-1']);
});
test('completed run survives reopen and does not fetch or duplicate events',async t=>{
  const c=setup(t);await c.run();c.reopen();const calls=c.transport.calls;const r=await c.run();
  assert.equal(r.outcome,'completed');assert.equal(c.transport.calls,calls);assert.equal(r.storedCandidateEvents,2);assert.equal(r.observations,4);
});
test('independent repeated observation run adds evidence but no new sales',async t=>{
  const c=setup(t);await c.run();const r=await c.run({runId:'second-run'});
  assert.equal(r.storedCandidateEvents,2);assert.equal(r.observations,8);
});
test('event-key conflict is quarantined instead of silently overwriting',async t=>{
  const f=fixture();mutatePage(f,'page-2',p=>p.records[0].title='Conflicting record');
  const c=setup(t,f);const r=await c.run();assert.equal(r.storedCandidateEvents,1);assert.equal(r.quarantined,2);
  assert.equal(Object.values(c.store.state.events).filter(e=>e.status==='conflicted').length,1);
});
for (const patch of [{mode:'approved_network'},{collectorEnabled:true}]) {
  test('no switch unlocks network mode '+JSON.stringify(patch),async t=>{
    const c=setup(t);const r=await c.run(patch);assert.equal(r.stopReason,'network_mode_disabled');assert.equal(c.transport.calls,0);
    assert.equal(Object.keys(c.store.state.observations).length,0);
  });
}
test('offline replay revocation is checked before every dispatch',async t=>{
  const c=setup(t);let checks=0;const r=await c.run({allowReplay:()=>++checks<5});
  assert.equal(r.outcome,'blocked');assert.equal(c.transport.calls,1);assert.equal(r.dataAsOf,null);
});
test('revocation after response prevents page publication',async t=>{
  const c=setup(t);let allowed=true;const base=c.transport.fetch.bind(c.transport);
  c.transport.fetch=async cursor=>{const value=await base(cursor);allowed=false;return value;};
  const r=await c.run({allowReplay:()=>allowed});assert.equal(r.stopReason,'replay_permission_revoked');assert.equal(r.observations,0);
});
for (const [status,kind] of [[401,'error'],[403,'error'],[200,'login_wall'],[200,'challenge'],[503,'challenge']]) {
  test(`access refusal ${status}/${kind} opens persistent circuit with no retry`,async t=>{
    const f=fixture();f.responses.start=[{status,kind,body:'synthetic access refusal'}];const c=setup(t,f);
    assert.equal((await c.run()).stopReason,'access_blocked');assert.equal(c.transport.calls,1);
    c.reopen();assert.equal((await c.run({runId:'another-run'})).stopReason,'circuit_open');assert.equal(c.transport.calls,1);
  });
}
test('200 error document is not an empty successful search',async t=>{
  const f=fixture();f.responses.start=[{status:200,kind:'error',body:'{}'}];const c=setup(t,f);const r=await c.run();
  assert.equal(r.stopReason,'schema_mismatch');assert.equal(r.dataAsOf,null);assert.equal(r.observations,0);
});
test('verified synthetic empty page is distinguished from an invalid error page',async t=>{
  const f=fixture();mutatePage(f,'start',p=>{p.records=[];p.nextCursor=null;});f.responses.start[0].kind='empty';
  const c=setup(t,f);const r=await c.run();assert.equal(r.outcome,'completed');assert.equal(r.storedCandidateEvents,0);assert.equal(r.completedPages,1);
});
for (const field of ['sourceId','queryHash','cursor','coverageAsOf']) {
  test('invalid page binding/date fails closed: '+field,async t=>{
    const f=fixture();mutatePage(f,'start',p=>p[field]=field==='coverageAsOf'?'2026-11-17T00:00:00Z':'wrong');
    const c=setup(t,f);const r=await c.run();assert.equal(r.stopReason,'schema_mismatch');assert.equal(r.observations,0);assert.equal(r.dataAsOf,null);
  });
}
test('one invalid record prevents the entire page from committing',async t=>{
  const f=fixture();mutatePage(f,'start',p=>p.records[1].identityEvidence='inferred_from_title');
  const c=setup(t,f);const r=await c.run();assert.equal(r.stopReason,'schema_mismatch');assert.equal(r.storedCandidateEvents,0);
});
test('cursor cycle terminates and never advances complete coverage',async t=>{
  const f=fixture();mutatePage(f,'start',p=>p.nextCursor='start');const c=setup(t,f);const r=await c.run();
  assert.equal(r.stopReason,'pagination_loop');assert.equal(c.transport.calls,1);assert.equal(r.dataAsOf,null);
});
for (const [patch,reason,calls] of [
  [{maxPages:1},'page_budget_exceeded',1],
  [{maxRequests:1},'request_budget_exceeded',1],
  [{maxBytes:1},'byte_budget_exceeded',0],
  [{maxAttempts:4},'invalid_plan',0],
]) {
  test('finite budget '+reason,async t=>{
    const c=setup(t);const r=await c.run(patch);assert.equal(r.stopReason,reason);assert.equal(c.transport.calls,calls);assert.equal(r.dataAsOf,null);
  });
}
test('429 honors Retry-After using logical time, then succeeds within budget',async t=>{
  const f=fixture();f.responses.start.unshift({status:429,kind:'error',body:'rate limit fixture',retryAfterSeconds:2});
  const c=setup(t,f);const r=await c.run();assert.equal(r.outcome,'completed');assert.equal(r.attempts,3);
  assert.equal(c.clock.now(),Date.parse(f.asOf)+2000);
});
test('rate limiting does not exceed deadline or silently ignore Retry-After',async t=>{
  const f=fixture();f.responses.start.unshift({status:429,kind:'error',body:'rate limit fixture',retryAfterSeconds:61});
  const c=setup(t,f);const r=await c.run();assert.equal(r.stopReason,'deadline_exceeded');assert.equal(c.transport.calls,1);
});
test('repeated 5xx has bounded attempts and no false watermark',async t=>{
  const f=fixture();f.responses.start=[{status:503,kind:'error',body:'upstream fixture unavailable'}];
  const c=setup(t,f);const r=await c.run();assert.equal(r.stopReason,'retry_exhausted');assert.equal(c.transport.calls,3);assert.equal(r.dataAsOf,null);
});
test('late fetch cannot commit after deadline',async t=>{
  const c=setup(t);const base=c.transport.fetch.bind(c.transport);
  c.transport.fetch=async cursor=>{const response=await base(cursor);c.advance(60001);return response;};
  const r=await c.run();assert.equal(r.stopReason,'deadline_exceeded');assert.equal(r.observations,0);
});
test('atomic page failure preserves old durable checkpoint, reopen/replay recovers exactly once',async t=>{
  const c=setup(t);let writes=0;c.store.beforePersist=()=>{if(++writes===3)throw new Error('injected storage failure');};
  const failed=await c.run();assert.equal(failed.stopReason,'storage_or_transport_error');assert.equal(failed.observations,0);assert.equal(failed.dataAsOf,null);
  c.reopen();const recovered=await c.run();assert.equal(recovered.outcome,'completed');assert.equal(recovered.storedCandidateEvents,2);assert.equal(recovered.observations,4);
});
test('budget reservations survive restart instead of resetting on transport failure',async t=>{
  const c=setup(t);const base=c.transport.fetch.bind(c.transport);
  c.transport.fetch=async cursor=>{if(cursor==='page-2')throw new Error('injected interrupted transport');return base(cursor);};
  await c.run({maxRequests:2});c.reopen();const calls=c.transport.calls;const r=await c.run({maxRequests:2});
  assert.equal(r.stopReason,'request_budget_exceeded');assert.equal(c.transport.calls,calls);assert.equal(r.completedPages,1);assert.equal(r.dataAsOf,null);
});
test('changed query cannot reuse an existing run checkpoint',async t=>{
  const c=setup(t);await c.run();const calls=c.transport.calls;const r=await c.run({queryHash:sha('other query')});
  assert.equal(r.stopReason,'run_binding_conflict');assert.equal(c.transport.calls,calls);
});
test('failure of a later run retains the last fully committed watermark',async t=>{
  const c=setup(t);await c.run();const r=await c.run({runId:'incomplete-later-run',maxPages:1});
  assert.equal(r.stopReason,'page_budget_exceeded');assert.equal(r.dataAsOf,'2026-11-15T23:00:00Z');
});
test('second writer is rejected, and reopening non-PoC state is rejected',t=>{
  const c=setup(t);assert.throws(()=>new Store(join(c.dir,'state.json')),/EEXIST/);
  const external=join(c.dir,'external.json');writeFileSync(external,JSON.stringify({schema:'production',dataMode:'live'}));
  assert.throws(()=>new Store(external),/store_schema_mismatch/);
});

test('untrusted plan identities are rejected before dispatch or map indexing',async t=>{
  const c=setup(t);
  for (const patch of [{runId:'__proto__'},{runId:'constructor'},{sourceId:{}},{queryHash:'not-a-hash'}]) {
    const r=await c.run(patch);assert.equal(r.stopReason,'invalid_plan');assert.equal(c.transport.calls,0);
  }
});
test('same version with malformed store shape is rejected on open',t=>{
  const c=setup(t);const path=join(c.dir,'corrupt.json');
  writeFileSync(path,JSON.stringify({schema:'offline-poc-1.0.0',dataMode:'offline_fixture'}));
  assert.throws(()=>new Store(path),/store_schema_mismatch/);
});
