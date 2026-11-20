#!/usr/bin/env python3
"""Run two bounded synthetic fault campaigns and analyze all scheduled tasks."""
import argparse
import csv
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from stability_report import plan, read_terminal_records, summarize

ROOT = Path(__file__).resolve().parents[2]
POC = ROOT / 'step0/collector-poc'


def run(output):
    output.mkdir(parents=True, exist_ok=False)
    with (ROOT / 'step0/corpus.csv').open(newline='') as handle:
        corpus = {row['id']: row for row in csv.DictReader(handle)}
    selected = {key for key in corpus if key.endswith('-01') or key.endswith('-11')}
    tasks = [{**task, 'query_id': task['task_id'].split('/')[1],
              'keyword': corpus[task['task_id'].split('/')[1]]['keyword']}
             for task in plan('2026-11-16') if task['task_id'].split('/')[1] in selected]
    if len(selected) != 12 or len(tasks) != 168:
        raise ValueError('Campaign requires 12 selected queries over 14 logical days')
    input_path = output / 'campaign-input.json'
    input_path.write_text(json.dumps(tasks, indent=2) + '\n')
    reports = {}
    for profile in ('transient', 'blocked_source'):
        command = ['node', '--import', str(POC / 'src/offline-network.ts'), str(POC / 'src/campaign.ts'),
                   str(input_path), str(output / profile), profile]
        result = subprocess.run(command, cwd=ROOT, env=dict(os.environ, COLLECTOR_ENABLED='false', DATA_MODE='offline_fixture'),
                                capture_output=True, text=True, timeout=120)
        (output / (profile + '.log')).write_text(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError(profile + ' failed: ' + result.stderr)
        rows, results_digest = read_terminal_records(output / profile / 'results.jsonl')
        analyzed = summarize(tasks, rows)
        analyzed['results_sha256'] = results_digest
        campaign = json.loads((output / profile / 'campaign-summary.json').read_text())
        if analyzed['summary']['started'] != 168 or len(rows) != 168 or any(row['actualChargePerformed'] for row in rows):
            raise ValueError('Incomplete or invalid campaign output')
        if profile == 'blocked_source':
            if campaign['sourceBlockIndex'] != 24 or campaign['dispatchesAfterBlock'] != 0:
                raise ValueError('Source refusal did not stop dispatch')
            if not any(row['cached_freshness'] == 'expired' for row in rows):
                raise ValueError('Long outage must expire current-price snapshots')
            if analyzed['summary']['final_semantic_success'] != 24 or campaign['sourceCircuitState'] != 'access_blocked':
                raise ValueError('Unexpected blocked-source scenario result')
        elif (analyzed['summary']['first_semantic_success'] != 138 or
              analyzed['summary']['final_semantic_success'] != 158 or
              campaign['stopReasons'] != {'request_budget_exceeded': 10}):
            raise ValueError('Unexpected transient-fault scenario result')
        reports[profile] = {'command': command, 'exitCode': result.returncode, 'campaign': campaign, 'analysis': analyzed}
    report = {'schema': 'soldbench.offline-campaign-validation.v1', 'result': 'PASS', 'mode': 'offline_fixture',
              'onlineVerified': False, 'sourceApproval': 'NOT_CLEARED', 'stageVerdict': 'NOT_ISSUED',
              'actualChargePerformed': False, 'logicalDays': 14, 'selectedQueries': sorted(selected),
              'corpus_sha256': hashlib.sha256((ROOT / 'step0/corpus.csv').read_bytes()).hexdigest(),
              'scope': '12-query synthetic regression subset; all 120 frozen queries still required for authorized online validation',
              'reports': reports}
    (output / 'campaign-validation.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path)
    args = parser.parse_args()
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    output = (args.output_dir or ROOT / 'step0/artifacts' / ('campaign-' + stamp)).resolve()
    run(output)
    print(str(output / 'campaign-validation.json'))
