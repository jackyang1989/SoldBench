#!/usr/bin/env python3
"""Evaluate local candidate annotations; release and evidence review stay external."""
import argparse
import csv
import json
import math
import re
from fractions import Fraction
from pathlib import Path
from verify_fixture import summary
from unit_economics import exact

ROOT = Path(__file__).resolve().parents[1]


def wilson(success, total):
    if not total:
        return None
    z = 1.959963984540054
    p = success / total
    denominator = 1 + z * z / total
    center = (p + z * z / (2 * total)) / denominator
    half_width = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return {'level': 0.95, 'low': max(0, center - half_width), 'high': min(1, center + half_width)}


def report(data, corpus=ROOT / 'corpus.csv'):
    if data.get('schema') != 'soldbench.quality-input.v1' or data.get('evidence_kind') not in ('synthetic', 'human_adjudicated'):
        raise ValueError('Invalid quality input schema or evidence kind')
    with corpus.open(newline='') as handle:
        queries = {row['id']: row for row in csv.DictReader(handle)}
    snapshots = {}
    event_splits = {}
    expected = set()
    for snapshot in data['snapshots']:
        query = snapshot['query_id']
        if query not in queries or query in snapshots:
            raise ValueError('Unknown or duplicate query snapshot')
        if snapshot['split'] not in ('development', 'holdout') or type(snapshot['candidate_set_complete']) is not bool:
            raise ValueError('Invalid split or completeness marker')
        if not re.fullmatch(r'[0-9a-f]{64}', snapshot['candidate_set_hash']):
            raise ValueError('Expected candidate snapshot SHA256')
        candidates = snapshot['candidate_ids']
        if not isinstance(candidates, list) or any(not isinstance(value, str) or not value for value in candidates):
            raise ValueError('Candidate manifest requires nonempty string IDs')
        if len(set(candidates)) != len(candidates):
            raise ValueError('Duplicate event in candidate manifest')
        if data['evidence_kind'] == 'human_adjudicated' and not snapshot.get('evidence_ref'):
            raise ValueError('Human snapshot requires controlled evidence')
        for event in candidates:
            previous = event_splits.setdefault(event, snapshot['split'])
            if previous != snapshot['split']:
                raise ValueError('Event leaks between development and holdout')
            expected.add((query, event))
        snapshots[query] = snapshot
    labels = {}
    for row in data['rows']:
        key = (row['query_id'], row['candidate_id'])
        if key not in expected or key in labels:
            raise ValueError('Unplanned or duplicate annotation')
        if type(row['predicted_comparable']) is not bool or (row['gold_comparable'] is not None and type(row['gold_comparable']) is not bool):
            raise ValueError('Comparable fields require bool or unknown gold')
        for field in ('gold_price_cents', 'predicted_price_cents'):
            value = row[field]
            if value is not None and (type(value) is not int or value < 0 or value > 9_007_199_254_740_991):
                raise ValueError('Invalid integer cents')
        if data['evidence_kind'] == 'human_adjudicated':
            annotators = row.get('annotator_ids')
            if not isinstance(annotators, list) or len(annotators) < 2 or len(set(annotators)) != len(annotators):
                raise ValueError('Human gold requires distinct annotator references')
            if not all(isinstance(value, str) and value.strip() for value in annotators) or not row.get('adjudication_ref'):
                raise ValueError('Human gold requires adjudication evidence')
        labels[key] = row

    def aggregate(query_ids):
        keys = {key for key in expected if key[0] in query_ids}
        rows = [labels[key] for key in keys if key in labels]
        known = [row for row in rows if row['gold_comparable'] is not None]
        tp = sum(row['gold_comparable'] and row['predicted_comparable'] for row in known)
        fp = sum(not row['gold_comparable'] and row['predicted_comparable'] for row in known)
        fn = sum(row['gold_comparable'] and not row['predicted_comparable'] for row in known)
        tn = len(known) - tp - fp - fn
        complete_labels = len(known) == len(keys)
        complete_candidates = bool(query_ids) and all(snapshots[query]['candidate_set_complete'] for query in query_ids)
        precision = tp / (tp + fp) if complete_labels and tp + fp else None
        recall = tp / (tp + fn) if complete_labels and complete_candidates and tp + fn else None
        # Never pool prices across different products. Median error is per query below.
        return {'queries': len(query_ids), 'expected_candidates': len(keys), 'annotation_rows': len(rows),
                'missing_annotations': len(keys) - len(rows), 'unknown_gold': len(rows) - len(known),
                'tp': tp, 'fp': fp, 'fn': fn, 'tn': tn, 'complete_candidate_snapshots': complete_candidates,
                'precision': precision, 'recall_within_candidate_snapshot': recall,
                'precision_wilson': wilson(tp, tp + fp) if precision is not None else None,
                'recall_wilson': wilson(tp, tp + fn) if recall is not None else None}

    per_query = {}
    for query, snapshot in snapshots.items():
        rows = [row for (qid, _), row in labels.items() if qid == query]
        gold_prices = [row['gold_price_cents'] for row in rows if row['gold_comparable'] is True and row['gold_price_cents'] is not None]
        predicted_prices = [row['predicted_price_cents'] for row in rows if row['predicted_comparable'] and row['predicted_price_cents'] is not None]
        result = aggregate({query})
        gold_median = summary(gold_prices)['median_cents']
        predicted_median = summary(predicted_prices)['median_cents']
        error = None
        if result['missing_annotations'] == 0 and result['unknown_gold'] == 0 and snapshot['candidate_set_complete'] and gold_median and predicted_median is not None:
            error = Fraction(abs(predicted_median - gold_median), gold_median)
        result.update(gold_verified_price_count=len(gold_prices), predicted_price_count=len(predicted_prices),
                      gold_median_cents=gold_median, predicted_median_cents=predicted_median,
                      median_absolute_relative_error=exact(error))
        per_query[query] = result

    def stratify(field, values):
        return {value: aggregate({qid for qid in snapshots if queries[qid][field] == value}) for value in values}

    return {'schema': 'soldbench.quality-report.v1', 'evidence_kind': data['evidence_kind'],
            'scope': 'observed_candidate_snapshots_only', 'summary': aggregate(set(snapshots)), 'by_query': per_query,
            'by_group': stratify('group', sorted({queries[qid]['group'] for qid in snapshots})),
            'by_tier': stratify('tier', sorted({queries[qid]['tier'] for qid in snapshots})),
            'by_split': {split: aggregate({qid for qid, value in snapshots.items() if value['split'] == split})
                         for split in ('development', 'holdout')},
            'externalEvidenceVerified': False, 'releaseApproved': False, 'quality_score': None}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    args = parser.parse_args()
    print(json.dumps(report(json.loads(args.input.read_text())), indent=2))
