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
        ('corpus', [sys.executable, 'step0/tools/check_corpus.py']),
        ('preparation-tests', [sys.executable, '-m', 'unittest', 'discover', '-s', 'step0/tests', '-v']),
        ('source-preparation', [sys.executable, 'step0/tools/readiness.py']),
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
    hashes = {}
    paths = [ROOT / 'v14_gameboy_58_verified.json', ROOT / 'step0/corpus.csv', ROOT / 'step0/corpus-manifest.json',
             POC / 'package-lock.json', POC / 'tsconfig.json', *sorted((POC / 'src').glob('*.ts')),
             *sorted((POC / 'tests').glob('*.ts')), *sorted((ROOT / 'step0/tools').glob('*.py')),
             *sorted((ROOT / 'step0/tests').glob('*.py')), *sorted((ROOT / 'step0/unit-economics').glob('*.json')),
             ROOT / 'step0/source-clearance.csv', ROOT / 'step0/source-capabilities.csv']
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
