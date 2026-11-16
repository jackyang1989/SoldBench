import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, FixtureTransport, collect } from './collector.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(['--fixtures','--state','--report']);
  const options: Record<string,string> = {};
  for (let i=0; i<args.length; i+=2) {
    if (!allowed.has(args[i]) || !args[i+1] || args[i+1].startsWith('--') || options[args[i]]) {
      throw new Error('Usage: node src/cli.ts [--fixtures local.json] [--state new-or-existing.json] [--report report.json]');
    }
    options[args[i]] = args[i+1];
  }
  if (process.env.COLLECTOR_ENABLED && process.env.COLLECTOR_ENABLED !== 'false') throw new Error('COLLECTOR_ENABLED must be false');
  if (process.env.DATA_MODE && process.env.DATA_MODE !== 'offline_fixture') throw new Error('Only offline_fixture is implemented');
  const fixturePath = resolve(options['--fixtures'] ?? resolve(root,'fixtures/demo.json'));
  const statePath = resolve(options['--state'] ?? resolve(root,'artifacts/demo-state.json'));
  const reportPath = resolve(options['--report'] ?? resolve(root,'artifacts/demo-report.json'));
  if (new Set([fixturePath,statePath,reportPath]).size !== 3) throw new Error('Fixture, state and report paths must differ');
  if (existsSync(reportPath) && !reportPath.startsWith(resolve(root,'artifacts')+'/')) throw new Error('Use a new report path; refusing to overwrite an existing external file');
  if (statSync(fixturePath).size > 1024*1024) throw new Error('Fixture file too large');
  const input = JSON.parse(readFileSync(fixturePath,'utf8'));
  if (input.synthetic !== true || input.version !== 1) throw new Error('Only marked synthetic fixtures are supported');
  mkdirSync(dirname(statePath),{recursive:true}); mkdirSync(dirname(reportPath),{recursive:true});
  const store = new Store(statePath);
  try {
    // Time is fixed/logical, so demo retries do not sleep and never claim real online stability.
    let now = Date.parse(input.asOf);
    const report = await collect({ ...input.plan, asOf:input.asOf, mode:'offline_fixture', collectorEnabled:false,
      allowReplay:() => true }, new FixtureTransport(input.responses), store,
      {now:() => now, wait:async ms => {now += ms;}});
    writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    process.stdout.write(JSON.stringify({...report,stateFile:statePath,reportFile:reportPath},null,2)+'\n');
    if (report.outcome !== 'completed') process.exitCode=1;
  } finally {store.close();}
}
main().catch(error => {process.stderr.write(String(error.message)+'\n');process.exitCode=1;});
