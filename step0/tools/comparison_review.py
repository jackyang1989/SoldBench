#!/usr/bin/env python3
"""Prepare a provider-blind review packet and score the adjudicated observations."""
import argparse
import csv
import hashlib
import hmac
import json
import os
import re
import secrets
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from quality_report import ROOT, report


def require(condition, message):
    if not condition:
        raise ValueError(message)


def serial(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()


def digest(value):
    return hashlib.sha256(serial(value)).hexdigest()


def identifier(value):
    return isinstance(value, str) and re.fullmatch(r'[a-z][a-z0-9_-]{0,79}', value)


def reference(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}', value)


def checksum(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value)


def utc(value):
    require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', value),
            'Expected an exact UTC timestamp')
    return datetime.fromisoformat(value[:-1] + '+00:00')


def price(value):
    return value is None or (type(value) is int and 0 <= value <= 9_007_199_254_740_991)


def filter_scope(scope):
    required = {'q', 'marketplace', 'currency', 'window_days', 'price_basis'}
    allowed = required | {'condition', 'sale_format', 'category', 'brand', 'model', 'attributes',
                          'min_price_cents', 'max_price_cents'}
    require(isinstance(scope, dict) and required <= scope.keys() <= allowed, 'Invalid comparison filters')
    require(isinstance(scope['q'], str) and 0 < len(scope['q'].strip()) <= 120
            and scope['marketplace'] == 'ebay_us' and scope['currency'] == 'USD'
            and type(scope['window_days']) is int and scope['window_days'] in (30, 90)
            and scope['price_basis'] in ('item', 'item_plus_observed_shipping'), 'Invalid market or price scope')
    require(all(type(scope[key]) is str and 0 < len(scope[key].strip()) <= 120
                for key in ('condition', 'sale_format', 'category', 'brand', 'model') if key in scope),
            'Invalid comparison filter value')
    attributes = scope.get('attributes', {})
    require(isinstance(attributes, dict) and len(attributes) <= 20
            and all(identifier(key) and isinstance(value, str) and 0 < len(value.strip()) <= 120
                    for key, value in attributes.items()), 'Invalid comparison attributes')
    for field in ('min_price_cents', 'max_price_cents'):
        require(field not in scope or (scope[field] is not None and price(scope[field])), 'Invalid money bound')
    require(scope.get('min_price_cents', 0) <= scope.get('max_price_cents', 9_007_199_254_740_991),
            'Inverted money bounds')


def prepare(data, key=None, corpus=ROOT / 'corpus.csv'):
    require(data.get('schema') == 'soldbench.comparison-input.v1', 'Invalid comparison input schema')
    require(data.get('evidence_kind') in ('synthetic', 'human_adjudicated'), 'Invalid evidence kind')
    require(checksum(data.get('corpus_sha256')) and hashlib.sha256(corpus.read_bytes()).hexdigest() == data['corpus_sha256'],
            'Corpus hash mismatch')
    with corpus.open(newline='') as handle:
        catalog = {row['id']: row for row in csv.DictReader(handle)}
    providers = data['providers']
    require(isinstance(providers, list) and 2 <= len(providers) <= 10
            and all(identifier(provider) for provider in providers) and len(set(providers)) == len(providers),
            'Expected two to ten distinct providers')
    require('soldbench' in providers, 'Comparison must include SoldBench')
    planned = {}
    for query in data['queries']:
        qid = query['query_id']
        require(qid in catalog and qid not in planned, 'Unknown or duplicate planned query')
        require(query['split'] in ('development', 'holdout'), 'Invalid frozen split')
        utc(query['as_of'])
        filter_scope(query['filters'])
        planned[qid] = query
    require(planned, 'Expected at least one planned query')
    snapshots, subjects, splits, evidence_owners = {}, {}, {}, {}
    key = key if key is not None else secrets.token_bytes(32)
    for snapshot in data['snapshots']:
        qid, provider = snapshot['query_id'], snapshot['provider']
        index = (qid, provider)
        require(qid in planned and provider in providers and index not in snapshots, 'Unplanned or duplicate provider run')
        plan = planned[qid]
        require(serial(snapshot['filters']) == serial(plan['filters']) and snapshot['as_of'] == plan['as_of'],
                'Provider query scope changed')
        captured, anchor = utc(snapshot['captured_at']), utc(plan['as_of'])
        require(captured.date() == anchor.date() and captured >= anchor, 'Provider capture outside the planned UTC day')
        status = snapshot['status']
        require(status in ('available', 'unavailable', 'unsupported'), 'Invalid provider status')
        rows = snapshot['rows']
        require(isinstance(rows, list) and len(rows) <= 2000, 'Provider rows are not a bounded candidate list')
        require(type(snapshot['candidate_set_complete']) is bool, 'Invalid candidate completeness')
        if status == 'available':
            require(checksum(snapshot.get('candidate_set_hash')) and reference(snapshot.get('evidence_ref')),
                    'Available run requires source evidence and a candidate hash')
        else:
            require(not rows and not snapshot['candidate_set_complete'] and snapshot.get('candidate_set_hash') is None
                    and identifier(snapshot.get('reason')), 'Unavailable run requires an explicit reason and no candidates')
        events = set()
        review_ids = []
        for row in rows:
            event = row['event_id']
            require(reference(event) and event not in events, 'Invalid or duplicate event')
            require(type(row['predicted_comparable']) is bool and price(row['predicted_price_cents']),
                    'Invalid predicted comparison or price')
            require(row['predicted_comparable'] or row['predicted_price_cents'] is None,
                    'Excluded predictions cannot supply a comparable price')
            evidence = row['blind_evidence_ref']
            require(isinstance(evidence, str) and re.fullmatch(r'obs-[a-f0-9]{16,64}', evidence),
                    'Use a provider-neutral evidence ID')
            require(evidence_owners.setdefault((qid, evidence), event) == event,
                    'Evidence ID is shared by different events')
            events.add(event)
            require(splits.setdefault(event, plan['split']) == plan['split'], 'Event leaks between study splits')
            blind_id = hmac.new(key, serial([qid, event]), hashlib.sha256).hexdigest()
            subject = {'query_id': qid, 'blind_id': blind_id, 'blind_evidence_ref': evidence}
            require(subjects.setdefault(blind_id, subject) == subject, 'Conflicting evidence for the same event')
            review_ids.append(blind_id)
        snapshots[index] = {**snapshot, 'review_ids': review_ids}
    require(len(snapshots) == len(planned) * len(providers), 'A planned provider run is missing; record its unavailable status')
    require(len(subjects) <= 60_000, 'Comparison packet exceeds review capacity')
    packet = {'schema': 'soldbench.comparison-packet.v1', 'queries': [
        {'query_id': qid, 'filters': query['filters'], 'as_of': query['as_of']}
        for qid, query in sorted(planned.items())], 'items': [subjects[key] for key in sorted(subjects)]}
    private = {'schema': 'soldbench.comparison-private.v1', 'packet_sha256': digest(packet),
               'input_sha256': digest(data), 'plan': data, 'snapshots': list(snapshots.values())}
    return packet, private


def evaluate(private, packet, reviews, decisions, corpus=ROOT / 'corpus.csv'):
    require(private.get('schema') == 'soldbench.comparison-private.v1'
            and digest(packet) == private.get('packet_sha256'), 'Review packet checksum mismatch')
    plan = private['plan']
    require(digest(plan) == private.get('input_sha256'), 'Frozen study input changed')
    require(hashlib.sha256(corpus.read_bytes()).hexdigest() == plan['corpus_sha256'],
            'Corpus hash mismatch')
    items = {item['blind_id']: item for item in packet['items']}
    qid_to_plan = {query['query_id']: query for query in plan['queries']}
    by_sample = defaultdict(dict)
    reviewer_ids = set()
    for review in reviews:
        require(review['packet_sha256'] == private['packet_sha256'], 'Review references a different packet')
        reviewer = review['reviewer_id']
        require(identifier(reviewer) and reviewer not in reviewer_ids, 'Reviewer must be distinct')
        reviewer_ids.add(reviewer)
        observed = set()
        for row in review['rows']:
            blind_id = row['blind_id']
            require(blind_id in items and blind_id not in observed, 'Unplanned or duplicate review row')
            observed.add(blind_id)
            by_sample[blind_id][reviewer] = judgment(row)
    require(len(reviewer_ids) == 2, 'Exactly two independent reviewer inputs are required')
    require(decisions['packet_sha256'] == private['packet_sha256'], 'Adjudication references a different packet')
    adjudications = {}
    for row in decisions['rows']:
        target = row['blind_id']
        require(target in items and target not in adjudications, 'Unplanned or duplicate adjudication')
        require(identifier(row['reviewer_id']) and row['reviewer_id'] not in reviewer_ids
                and reference(row.get('evidence_ref')), 'Adjudication requires a third reviewer and evidence')
        values = list(by_sample[target].values())
        require(len(values) == 2 and values[0] != values[1], 'Only disagreements after two reviews can be adjudicated')
        adjudications[target] = (judgment(row), row['evidence_ref'])
    faults = {'missing_second_review': 0, 'open_disagreements': 0, 'adjudicated_disagreements': 0,
              'agreed_reviews': 0, 'unknown_comparability': 0}
    labels = {}
    for target in items:
        values = list(by_sample[target].values())
        if len(values) < 2:
            faults['missing_second_review'] += 1
            continue
        if values[0] == values[1]:
            faults['agreed_reviews'] += 1
            labels[target] = (*values[0], 'independent_consensus')
        elif target in adjudications:
            faults['adjudicated_disagreements'] += 1
            value, ref = adjudications[target]
            labels[target] = (*value, ref)
        else:
            faults['open_disagreements'] += 1
    faults['unknown_comparability'] = sum(label[0] is None for label in labels.values())
    by_provider = {}
    frozen_snapshots = {(row['query_id'], row['provider']): row for row in plan['snapshots']}
    seen = set()
    for snapshot in private['snapshots']:
        key = (snapshot['query_id'], snapshot['provider'])
        require(key in frozen_snapshots and key not in seen, 'Unknown or duplicate frozen snapshot')
        seen.add(key)
        frozen = frozen_snapshots[key]
        require({key: value for key, value in snapshot.items() if key != 'review_ids'} == frozen,
                'Frozen snapshot facts changed')
        review_ids = snapshot['review_ids']
        require(len(review_ids) == len(frozen['rows']) and len(set(review_ids)) == len(review_ids)
                and all(target in items and items[target]['query_id'] == frozen['query_id']
                        and items[target]['blind_evidence_ref'] == candidate['blind_evidence_ref']
                        for target, candidate in zip(review_ids, frozen['rows'])), 'Frozen review mapping changed')
    require(seen == frozen_snapshots.keys(), 'Frozen snapshot mapping incomplete')
    for provider in plan['providers']:
        snapshots, rows, unavailable = [], [], {}
        for snapshot in private['snapshots']:
            if snapshot['provider'] != provider:
                continue
            qid = snapshot['query_id']
            if snapshot['status'] != 'available':
                unavailable[qid] = {'status': snapshot['status'], 'reason': snapshot['reason']}
                continue
            candidates = snapshot['rows']
            snapshots.append({'query_id': qid, 'candidate_ids': [row['event_id'] for row in candidates],
                              'candidate_set_hash': snapshot['candidate_set_hash'],
                              'candidate_set_complete': snapshot['candidate_set_complete'],
                              'split': qid_to_plan[qid]['split'], 'evidence_ref': snapshot['evidence_ref']})
            for review_id, candidate in zip(snapshot['review_ids'], candidates):
                if review_id not in labels:
                    continue
                comparable, gold_price, ref = labels[review_id]
                rows.append({'query_id': qid, 'candidate_id': candidate['event_id'], 'gold_comparable': comparable,
                             'gold_price_cents': gold_price, 'predicted_comparable': candidate['predicted_comparable'],
                             'predicted_price_cents': candidate['predicted_price_cents'],
                             'annotator_ids': sorted(reviewer_ids), 'adjudication_ref': ref})
        evidence = report({'schema': 'soldbench.quality-input.v1', 'evidence_kind': plan['evidence_kind'],
                           'snapshots': snapshots, 'rows': rows}, corpus=corpus)
        by_provider[provider] = {'planned_queries': len(qid_to_plan), 'unavailable_queries': unavailable, 'quality': evidence}
    provider_pairs = {}
    mapped = {(run['query_id'], run['provider']): run for run in private['snapshots']}
    for provider in plan['providers']:
        if provider == 'soldbench':
            continue
        pairs = {}
        for qid in sorted(qid_to_plan):
            left, right = mapped[qid, 'soldbench'], mapped[qid, provider]
            left_ids, right_ids = set(left['review_ids']), set(right['review_ids'])
            shared = left_ids & right_ids
            known = {target for target in left_ids | right_ids if target in labels and labels[target][0] is not None}
            pairs[qid] = {'both_available': left['status'] == right['status'] == 'available',
                          'candidate_sets_complete': left['candidate_set_complete'] and right['candidate_set_complete'],
                          'union_candidate_count': len(left_ids | right_ids),
                          'shared_candidate_count': len(shared),
                          'shared_labeled_count': len(shared & known),
                          'soldbench_labeled_count': len(left_ids & known),
                          'comparison_labeled_count': len(right_ids & known),
                          'meets_exploration_sample_count': min(len(left_ids & known), len(right_ids & known)) >= 20}
        provider_pairs[provider] = pairs
    return {'schema': 'soldbench.comparison-report.v1', 'packet_sha256': private['packet_sha256'],
            'evidence_kind': plan['evidence_kind'], 'review': faults, 'providers': by_provider,
            'same_scope_pairs': provider_pairs,
            'externalEvidenceVerified': False, 'releaseApproved': False}


def judgment(row):
    comparable, amount = row['comparable'], row['verified_price_cents']
    require(comparable is None or type(comparable) is bool, 'Comparability must be true, false or unknown')
    require(price(amount) and (comparable is True or amount is None), 'Only verified comparable prices are eligible')
    return comparable, amount


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as handle:
        handle.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    cli = argparse.ArgumentParser(description=__doc__)
    sub = cli.add_subparsers(dest='command', required=True)
    preparation = sub.add_parser('prepare')
    preparation.add_argument('input')
    preparation.add_argument('output_dir', type=Path)
    scoring = sub.add_parser('evaluate')
    for name in ('private', 'packet', 'review_a', 'review_b', 'adjudications'):
        scoring.add_argument(name)
    args = cli.parse_args()
    if args.command == 'prepare':
        packet, private = prepare(read(args.input))
        args.output_dir.mkdir(mode=0o700)
        write(args.output_dir / 'review-packet.json', packet)
        write(args.output_dir / 'private-study.json', private)
        print(json.dumps({'packet_sha256': private['packet_sha256'], 'blind_samples': len(packet['items'])}))
    else:
        print(json.dumps(evaluate(read(args.private), read(args.packet),
                                  [read(args.review_a), read(args.review_b)], read(args.adjudications)),
                         ensure_ascii=False, indent=2))
