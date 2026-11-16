#!/usr/bin/env python3
"""Run the bounded offline package checks and preserve commands, exits and hashes."""
import hashlib
import json
import os
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
POC = ROOT / 'step0/collector-poc'


def main():
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    output = ROOT / 'step0/artifacts' / stamp
    output.mkdir(parents=True, exist_ok=False)
    tests = sorted(str(path.relative_to(ROOT)) for path in (POC / 'tests').glob('*.test.ts'))
    commands = [
        ('typecheck', [str(POC / 'node_modules/.bin/tsc'), '--project', str(POC / 'tsconfig.json'), '--noEmit']),
        ('poc-tests', ['node', '--import', str(POC / 'src/offline-network.ts'), '--test', *tests]),
        ('cli-first', ['node', '--import', str(POC / 'src/offline-network.ts'), str(POC / 'src/cli.ts'),
                       '--state', str(output / 'cli-state.json'), '--report', str(output / 'cli-first.json')]),
        ('cli-replay', ['node', '--import', str(POC / 'src/offline-network.ts'), str(POC / 'src/cli.ts'),
                        '--state', str(output / 'cli-state.json'), '--report', str(output / 'cli-replay.json')]),
        ('integrated-study', ['node', '--import', str(POC / 'src/offline-network.ts'), str(POC / 'src/study.ts'),
                              '--output-dir', str(output / 'integrated-study')]),
        ('fault-campaign', [sys.executable, 'step0/tools/replay_campaign.py', '--output-dir', str(output / 'fault-campaign')]),
        ('corpus', [sys.executable, 'step0/tools/check_corpus.py']),
        ('preparation-tests', [sys.executable, '-m', 'unittest', 'discover', '-s', 'step0/tests', '-v']),
        ('source-preparation', [sys.executable, 'step0/tools/readiness.py']),
        ('quality-empty', [sys.executable, 'step0/tools/quality_report.py', 'step0/labels/quality-input-empty.json']),
        ('dependency-inventory', [sys.executable, 'step0/tools/dependency_inventory.py']),
        ('economics-unmeasured', [sys.executable, 'step0/tools/unit_economics.py', 'step0/unit-economics/unmeasured.json']),
        ('economics-scenarios', [sys.executable, 'step0/tools/unit_economics.py', 'step0/unit-economics/scenarios.json']),
        ('stability-no-records', [sys.executable, 'step0/tools/stability_report.py', '--start', '2026-12-01']),
        ('golden', [sys.executable, 'step0/tools/verify_fixture.py']),
        ('documentation', [sys.executable, 'docs/check_docs.py']),
        ('contracts', [sys.executable, 'docs/contracts/check_contracts.py']),
    ]
    environment = dict(os.environ, COLLECTOR_ENABLED='false', DATA_MODE='offline_fixture', PYTHONDONTWRITEBYTECODE='1')
    checks = []
    for name, command in commands:
        try:
            result = subprocess.run(command, cwd=ROOT, env=environment, capture_output=True, text=True, timeout=120)
            code, log = result.returncode, result.stdout + result.stderr
        except (OSError, subprocess.TimeoutExpired) as error:
            code, log = 127, str(error)
        (output / (name + '.log')).write_text(log)
        checks.append({'name': name, 'command': command, 'exitCode': code, 'log': name + '.log'})
        print(name + ': ' + ('PASS' if code == 0 else 'FAIL'), flush=True)
    try:
        first = json.loads((output / 'cli-first.json').read_text())
        replay = json.loads((output / 'cli-replay.json').read_text())
        replay_ok = (first == replay and first['storedCandidateEvents'] == 2 and first['observations'] == 4
                     and first['quarantined'] == 1 and first['dataAsOf'] == '2026-11-15T23:00:00Z')
    except (OSError, ValueError, KeyError):
        replay_ok = False
    checks.append({'name': 'cli-replay-invariants', 'exitCode': 0 if replay_ok else 1,
                   'evidence': ['cli-first.json', 'cli-replay.json']})
    print('cli-replay-invariants: ' + ('PASS' if replay_ok else 'FAIL'), flush=True)
    try:
        study = json.loads((output / 'integrated-study/study-report.json').read_text())
        golden = json.loads((ROOT / 'v14_gameboy_58_verified.json').read_text())
        fresh = study['scenarios'][0]['result']
        study_ok = (fresh['stats'] == golden['expected_stats'] and fresh['quality'] == golden['expected_quality']
                    and study['collected'] == study['replay'] and len(study['scenarios']) == 10
                    and all(row['result'] is None for row in study['scenarios'] if 'rights' in row))
        summary = {key: study[key] for key in ('schema', 'mode', 'sourceApproval', 'onlineVerified', 'snapshotHash', 'collected', 'replay')}
        summary['scenarios'] = [{key: row[key] for key in ('hours', 'allowStale', 'rights', 'decision') if key in row} |
                                {'stats': row['result']['stats'] if row['result'] else None,
                                 'quality': row['result']['quality'] if row['result'] else None} for row in study['scenarios']]
        (output / 'integrated-study-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    except (OSError, ValueError, KeyError, TypeError):
        study_ok = False
    checks.append({'name': 'integrated-study-invariants', 'exitCode': 0 if study_ok else 1,
                   'evidence': ['integrated-study-summary.json']})
    print('integrated-study-invariants: ' + ('PASS' if study_ok else 'FAIL'), flush=True)
    hashes = {}
    paths = [ROOT / 'v14_gameboy_58_verified.json', ROOT / 'step0/corpus.csv', ROOT / 'step0/corpus-manifest.json',
             POC / 'package.json', POC / 'package-lock.json', POC / 'tsconfig.json', *sorted((POC / 'src').glob('*.ts')),
             *sorted((POC / 'tests').glob('*.ts')), *sorted((ROOT / 'step0/tools').glob('*.py')),
             *sorted((ROOT / 'step0/tests').glob('*.py')), *sorted((ROOT / 'step0/unit-economics').glob('*.json')),
             ROOT / 'step0/source-clearance.csv', ROOT / 'step0/source-capabilities.csv',
             ROOT / 'step0/labels/quality-input-empty.json']
    for path in paths:
        hashes[str(path.relative_to(ROOT))] = hashlib.sha256(path.read_bytes()).hexdigest()
    report = {'schema': 'soldbench.offline-validation.v1', 'createdAt': stamp, 'platform': platform.platform(),
              'python': platform.python_version(), 'node': subprocess.check_output(['node', '--version'], text=True).strip(),
              'mode': 'offline_fixture', 'collectorEnabled': False, 'onlineVerified': False,
              'database': 'none; temporary JSON single-writer store', 'account': 'synthetic fixtures; no product account',
              'simulationClock': '2026-11-16 UTC plus injected offsets; individual tests declare their own fixed as_of',
              'result': 'PASS' if all(check['exitCode'] == 0 for check in checks) else 'FAIL',
              'stageVerdict': 'NOT_ISSUED', 'independentReview': 'PENDING', 'checks': checks, 'sha256': hashes}
    (output / 'validation.json').write_text(json.dumps(report, indent=2) + '\n')
    print(str(output / 'validation.json'))
    return 0 if report['result'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
