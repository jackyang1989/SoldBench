#!/usr/bin/env python3
"""Analyze a frozen 14-day plan and local terminal records, without dispatching tasks."""
import argparse
import csv
import hashlib
import io
import json
from datetime import date, datetime, timedelta, timezone
from fractions import Fraction
from pathlib import Path
from unit_economics import count, decimal, exact

ROOT = Path(__file__).resolve().parents[1]
PLAN_SCHEMA = 'soldbench.stability-plan.v1'


def percentile(values, probability):
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = position.numerator // position.denominator
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (position - lower) * (ordered[upper] - ordered[lower])


def schedule(first, corpus_bytes):
    queries = list(csv.DictReader(io.StringIO(corpus_bytes.decode('utf8'), newline='')))
    if len(queries) != 120 or len({query['id'] for query in queries}) != 120:
        raise ValueError('Expected the frozen 120-query corpus')
    tasks = []
    for offset in range(14):
        day = (first + timedelta(days=offset)).isoformat()
        for index, query in enumerate(queries):
            tasks.append({'task_id': day + '/' + query['id'], 'date': day,
                          'scheduled_at': day + 'T' + ('00', '08', '16')[index % 3] + ':00:00Z',
                          'group': query['group'], 'tier': query['tier']})
    return tasks


def plan(start, corpus=ROOT / 'corpus.csv'):
    return schedule(date.fromisoformat(start), corpus.read_bytes())


def json_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def campaign_plan(start, corpus=ROOT / 'corpus.csv'):
    first = date.fromisoformat(start)
    corpus_bytes = corpus.read_bytes()
    tasks = schedule(first, corpus_bytes)
    definition = {'schema': PLAN_SCHEMA, 'start': first.isoformat(),
                  'until': (first + timedelta(days=14)).isoformat(),
                  'corpus_sha256': hashlib.sha256(corpus_bytes).hexdigest(), 'plan_sha256': json_digest(tasks)}
    return {**definition, 'campaign_sha256': json_digest(definition), 'tasks': tasks}


def load_campaign(path, corpus):
    with path.open() as handle:
        manifest = json.load(handle)
    if (not isinstance(manifest, dict) or manifest.get('schema') != PLAN_SCHEMA
            or not isinstance(manifest.get('start'), str)):
        raise ValueError('Unknown campaign plan schema')
    if manifest != campaign_plan(manifest['start'], corpus):
        raise ValueError('Campaign plan or its corpus differs from the frozen manifest')
    return manifest


def utc(value):
    if not isinstance(value, str) or not value.endswith('Z'):
        raise ValueError('Task times require UTC timestamps ending in Z')
    result = datetime.fromisoformat(value[:-1] + '+00:00')
    return result.astimezone(timezone.utc)


def summarize(tasks, records, campaign_sha256=None):
    planned = {task['task_id']: task for task in tasks}
    if len(planned) != len(tasks) or not tasks:
        raise ValueError('Plan must be nonempty with unique IDs')
    results = {}
    modes = set()
    for row in records:
        task_id = row['task_id']
        if task_id not in planned or task_id in results:
            raise ValueError('Unknown or duplicate terminal task ID')
        mode = row['mode']
        if mode not in ('offline_fixture', 'authorized_online'):
            raise ValueError('Invalid evidence mode')
        modes.add(mode)
        if len(modes) > 1:
            raise ValueError('Offline and online records cannot be mixed')
        if mode == 'authorized_online':
            if not (isinstance(row.get('evidence_ref'), str) and row['evidence_ref'].strip()):
                raise ValueError('Online rows require controlled evidence references')
            if not campaign_sha256 or row.get('campaign_sha256') != campaign_sha256:
                raise ValueError('Online row lacks the matching frozen campaign digest')
        started, finished = utc(row['started_at']), utc(row['finished_at'])
        if started.date().isoformat() != planned[task_id]['date'] or finished < started:
            raise ValueError('Invalid task day or duration')
        if mode == 'authorized_online' and started < utc(planned[task_id]['scheduled_at']):
            raise ValueError('Online task started before its frozen UTC slot')
        attempts = count(row['attempts'], 'attempts')
        for field in ('first_semantic_success', 'semantic_success', 'billable'):
            if type(row[field]) is not bool:
                raise ValueError('Success and billable fields require booleans')
        if row['billable'] and not row['semantic_success']:
            raise ValueError('Failed task cannot be billable')
        if row['first_semantic_success'] and not row['semantic_success']:
            raise ValueError('First-pass success requires final success')
        if attempts == 0 and row['semantic_success']:
            raise ValueError('A source-validation task cannot succeed without a request')
        for field in ('pages', 'bytes', 'cpu_ms'):
            count(row[field], field)
        if row['pages'] > attempts:
            raise ValueError('Committed pages cannot exceed request attempts')
        if row['cost_cents'] is not None:
            decimal(row['cost_cents'], 'cost_cents')
        results[task_id] = row

    def aggregate(selected):
        rows = [results[task['task_id']] for task in selected if task['task_id'] in results]
        first_success = sum(row['first_semantic_success'] for row in rows)
        success = sum(row['semantic_success'] for row in rows)
        known_costs = [decimal(row['cost_cents'], 'cost_cents') for row in rows if row['cost_cents'] is not None]
        missing_costs = len(rows) - len(known_costs)
        observed_cost = sum(known_costs, Fraction())
        complete = len(rows) == len(selected) and not missing_costs
        worst_count = max(1, (len(known_costs) + 19) // 20)
        worst_costs = sorted(known_costs, reverse=True)[:worst_count]
        latencies = []
        for row in rows:
            elapsed = utc(row['finished_at']) - utc(row['started_at'])
            microseconds = elapsed.days * 86_400_000_000 + elapsed.seconds * 1_000_000 + elapsed.microseconds
            latencies.append(Fraction(microseconds, 1000))
        return {'planned': len(selected), 'started': len(rows), 'missing': len(selected) - len(rows),
                'first_semantic_success': first_success, 'final_semantic_success': success,
                'billable_results': sum(row['billable'] for row in rows),
                'schedule_execution_rate': len(rows) / len(selected),
                'first_success_rate': first_success / len(selected), 'final_success_rate': success / len(selected),
                'attempts': sum(row['attempts'] for row in rows),
                'pages': sum(row['pages'] for row in rows), 'bytes': sum(row['bytes'] for row in rows),
                'cpu_ms': sum(row['cpu_ms'] for row in rows),
                'observed_known_cost_cents': exact(observed_cost, True) if known_costs else None,
                'cost_unknown_records': missing_costs,
                'observed_duration_ms_p95': exact(percentile(latencies, Fraction(95, 100))),
                'observed_cost_distribution': {
                    'records': len(known_costs), 'p50_cents': exact(percentile(known_costs, Fraction(1, 2)), True),
                    'p95_cents': exact(percentile(known_costs, Fraction(95, 100)), True),
                    'worst_5pct_mean_cents': exact(sum(worst_costs, Fraction()) / len(worst_costs), True),
                } if known_costs and not missing_costs else None,
                'plan_total_cost_cents': exact(observed_cost, True) if complete else None}

    def groups(field):
        return {value: aggregate([task for task in tasks if task[field] == value]) for value in sorted({task[field] for task in tasks})}

    return {'schema': 'soldbench.stability-report.v1', 'mode': next(iter(modes), 'no_records'),
            'summary': aggregate(tasks), 'by_day': groups('date'), 'by_group': groups('group'), 'by_tier': groups('tier'),
            'days_with_all_planned_terminal_records': sum(all(task['task_id'] in results for task in tasks if task['date'] == day)
                                                      for day in {task['date'] for task in tasks}),
            'externalEvidenceVerified': False, 'stageVerdict': 'NOT_ISSUED',
            'plan_sha256': json_digest(tasks)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument('--start')
    inputs.add_argument('--plan', type=Path)
    parser.add_argument('--corpus', type=Path, default=ROOT / 'corpus.csv')
    parser.add_argument('--freeze-plan', type=Path)
    parser.add_argument('--results', type=Path)
    args = parser.parse_args()
    if args.freeze_plan and (args.plan or args.results):
        parser.error('--freeze-plan requires --start and excludes --results')
    campaign = load_campaign(args.plan, args.corpus) if args.plan else campaign_plan(args.start, args.corpus)
    if args.freeze_plan:
        with args.freeze_plan.open('x') as handle:
            handle.write(json.dumps(campaign, indent=2) + '\n')
        print(campaign['campaign_sha256'])
        raise SystemExit(0)
    records = []
    if args.results:
        with args.results.open() as handle:
            for line in handle:
                if line.strip():
                    records.append(json.loads(line))
                if len(records) > 1680:
                    raise ValueError('Results exceed the 14-day plan')
    report = summarize(campaign['tasks'], records, campaign['campaign_sha256'] if args.plan else None)
    report['corpus_sha256'] = campaign['corpus_sha256']
    report['campaign_sha256'] = campaign['campaign_sha256']
    print(json.dumps(report, indent=2))
