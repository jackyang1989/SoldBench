#!/usr/bin/env python3
"""Project a full-quota month from explicitly weighted, evidence-linked workload units."""
import argparse
import json
import re
from collections import defaultdict
from datetime import datetime
from fractions import Fraction
from pathlib import Path

from unit_economics import VARIABLE, calculate, count, decimal, exact

COHORTS = {'paid', 'free'}
OUTCOMES = {'charged', 'free_delivery', 'queued', 'failed', 'low_sample', 'stale', 'refetch'}
PATHS = {'first', 'cache'}
DIMENSIONS = ('cohort', 'outcome', 'path', 'limit', 'with_media')


def stratum(value):
    cohort, outcome, path, limit, media = (value[key] for key in DIMENSIONS)
    if (cohort not in COHORTS or outcome not in OUTCOMES or path not in PATHS or
            type(limit) is not int or not 1 <= limit <= 200 or type(media) is not bool):
        raise ValueError('Unknown workload stratum')
    if outcome == 'charged' and cohort != 'paid':
        raise ValueError('A free-cohort unit cannot be charged in the paid projection')
    return cohort, outcome, path, limit, media


def reference(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./:-]{0,159}', value)


def utc(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', value):
        raise ValueError('Use UTC second precision in the observation window')
    return datetime.fromisoformat(value[:-1] + '+00:00')


def tail(distribution):
    if not distribution:
        return {'p50': None, 'p95': None, 'worst_5_percent_average': None}
    ordered = sorted(distribution)
    total = sum(weight for _, weight in ordered)
    values = {}
    for key, q in [('p50', Fraction(1, 2)), ('p95', Fraction(19, 20))]:
        cumulative = Fraction()
        for cost, weight in ordered:
            cumulative += weight
            if cumulative >= total * q:
                values[key] = exact(cost, True)
                break
    tail_weight = remaining = total / 20
    tail_cost = Fraction()
    for cost, weight in reversed(ordered):
        included = min(weight, remaining)
        tail_cost += cost * included
        remaining -= included
        if remaining == 0:
            break
    return {**values, 'worst_5_percent_average': exact(tail_cost / tail_weight, True)}


def project(data):
    if data.get('schema') != 'soldbench.full-quota-input.v1':
        raise ValueError('Unknown full-quota input schema')
    kind, evidence = data['evidence_kind'], data.get('evidence_ref')
    if kind not in ('assumed', 'measured') or (kind == 'measured' and not reference(evidence)):
        raise ValueError('Measured projection inputs require a controlled evidence reference')
    start, end = utc(data['observed_from']), utc(data['observed_until'])
    if end <= start:
        raise ValueError('Observation window must have positive duration')
    plan = data['plan']
    if not reference(plan['code']) or not reference(plan['policy_version']):
        raise ValueError('Specify the plan and quota policy version')
    customers = count(plan['customers'], 'customers')
    quota = count(plan['credits_per_customer'], 'credits_per_customer')
    if customers == 0 or quota == 0:
        raise ValueError('A full paid quota scenario needs paid customers and a positive quota')

    workload = {}
    for row in data['workload']:
        key = stratum(row)
        if key in workload:
            raise ValueError('Duplicate projected workload stratum')
        if kind == 'measured' and not reference(row.get('projection_ref')):
            raise ValueError('Document the projected workload weight for every stratum')
        workload[key] = count(row['projected_units'], 'projected_units')
    expected_charged = customers * quota
    observed_projection = sum(units for key, units in workload.items() if key[1] == 'charged')
    if observed_projection != expected_charged:
        raise ValueError('Projected charged units must match customers × credits per customer')

    observations = defaultdict(list)
    seen = set()
    for row in data['observations']:
        key, unit_id = stratum(row), row['unit_id']
        if key not in workload or not reference(unit_id) or unit_id in seen:
            raise ValueError('Observation is out of scope or repeats an accounted workload unit')
        if not start <= utc(row['observed_at']) < end:
            raise ValueError('Unit observed outside the measurement window')
        if kind == 'measured' and not reference(row.get('evidence_ref')):
            raise ValueError('Measured unit requires cost evidence')
        seen.add(unit_id)
        costs = row['costs']
        if set(costs) != set(VARIABLE):
            raise ValueError('Every variable resource category must be explicit')
        values = {category: decimal(costs[category], category) for category in VARIABLE
                  if costs[category] is not None}
        observations[key].append(values if len(values) == len(VARIABLE) else None)

    finance = data['monthly_finance']
    if finance.get('customers') != customers or finance.get('billable_queries') not in (None, expected_charged):
        raise ValueError('Monthly finance must match the projected paid cohort and delivery count')
    if finance.get('evidence_kind') != kind:
        raise ValueError('Monthly finance and workload must use the same evidence classification')
    if any(finance['costs'].get(category) is not None for category in VARIABLE):
        raise ValueError('Variable costs are derived from units and must not be prefilled in monthly finance')

    totals = dict.fromkeys(VARIABLE, Fraction())
    distribution, strata, incomplete = [], [], False
    for key, units in sorted(workload.items()):
        samples = observations[key]
        known = [sample for sample in samples if sample is not None]
        complete = units == 0 or (bool(known) and len(known) == len(samples))
        partial = {**dict(zip(DIMENSIONS, key)), 'projected_units': units, 'observed_units': len(samples),
                   'costed_units': len(known), 'complete': complete}
        incomplete |= not complete
        if units and complete:
            weight = Fraction(units, len(known))
            for category in VARIABLE:
                totals[category] += sum(sample[category] for sample in known) * weight
            if key[1] == 'charged':
                distribution.extend((sum(sample.values()), weight) for sample in known)
        strata.append(partial)

    result = calculate({**finance, 'billable_queries': expected_charged},
                       projected_variable_costs=None if incomplete else totals)
    return {
        'schema': 'soldbench.full-quota-report.v1',
        'evidence_kind': kind,
        'evidence_ref': evidence,
        'plan': plan,
        'observed_from': data['observed_from'],
        'observed_until': data['observed_until'],
        'status': result['status'],
        'forecast': 'full_quota_projection',
        'projected_workload': strata,
        'projected_variable_costs': None if incomplete else {key: exact(value, True) for key, value in totals.items()},
        'variable_cost_per_charged_unit': tail([] if incomplete else distribution),
        'monthly_finance': result,
        'priceApproved': False,
        'stabilityVerified': False,
        'stageVerdict': 'NOT_ISSUED',
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    args = parser.parse_args()
    print(json.dumps(project(json.loads(args.input.read_text())), indent=2))
