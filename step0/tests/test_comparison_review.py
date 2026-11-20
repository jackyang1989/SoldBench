import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from comparison_review import ROOT, evaluate, prepare, serial


def study():
    filters = {'q': 'Charizard Base Set Unlimited PSA 9', 'marketplace': 'ebay_us',
               'currency': 'USD', 'window_days': 30, 'price_basis': 'item'}
    timestamp = '2026-11-19T16:00:00Z'
    items = [{'event_id': f'source/event-{i}', 'blind_evidence_ref': f'obs-{i:016x}',
              'predicted_comparable': True, 'predicted_price_cents': 100 + i}
             for i in range(21)]
    query = {'query_id': 'cards-01', 'filters': filters, 'as_of': timestamp, 'split': 'holdout'}
    snapshots = [
        {key: value for key, value in query.items() if key != 'split'} | {
            'provider': provider, 'status': 'available', 'captured_at': '2026-11-19T17:00:00Z',
            'candidate_set_hash': 'a' * 64, 'evidence_ref': f'private:{provider}',
            'candidate_set_complete': True, 'rows': copy.deepcopy(rows),
        }
        for provider, rows in [('soldbench', items[:20]), ('fixture-peer', items[1:])]
    ]
    return {'schema': 'soldbench.comparison-input.v1',
            'corpus_sha256': hashlib.sha256((ROOT / 'corpus.csv').read_bytes()).hexdigest(),
            'evidence_kind': 'synthetic', 'providers': ['soldbench', 'fixture-peer'],
            'queries': [query], 'snapshots': snapshots}


def reviewers(packet, checksum):
    return [{'reviewer_id': reviewer, 'packet_sha256': checksum,
             'rows': [{'blind_id': item['blind_id'], 'comparable': True, 'verified_price_cents': 100}
                      for item in packet['items']]}
            for reviewer in ('reviewer-a', 'reviewer-b')]


class ComparisonReviewTests(unittest.TestCase):
    def setUp(self):
        self.packet, self.private = prepare(study(), b'fixture' * 5)
        self.checksum = self.private['packet_sha256']
        self.reviews = reviewers(self.packet, self.checksum)
        self.decisions = {'packet_sha256': self.checksum, 'rows': []}

    def test_blind_shared_subjects_and_same_scope_provider_metrics(self):
        encoded = serial(self.packet)
        for name in (b'fixture-peer', b'"soldbench"', b'predicted_price', b'source/event-', b'private:'):
            self.assertNotIn(name, encoded)
        self.assertEqual(len(self.packet['items']), 21)
        scored = evaluate(self.private, self.packet, self.reviews, self.decisions)
        self.assertEqual(scored['review']['agreed_reviews'], 21)
        pair = scored['same_scope_pairs']['fixture-peer']['cards-01']
        self.assertEqual(pair['shared_labeled_count'], 19)
        self.assertTrue(pair['meets_exploration_sample_count'])
        self.assertEqual(scored['providers']['soldbench']['quality']['summary']['precision'], 1)
        self.assertFalse(scored['releaseApproved'])
        another, _ = prepare(study(), b'other-fixture' * 3)
        self.assertNotEqual(self.packet['items'], another['items'])

    def test_unresolved_disagreement_and_missing_review_leave_metrics_unknown(self):
        self.reviews[1]['rows'][1]['verified_price_cents'] = 90
        self.reviews[1]['rows'].pop(0)
        scored = evaluate(self.private, self.packet, self.reviews, self.decisions)
        self.assertEqual(scored['review']['missing_second_review'], 1)
        self.assertEqual(scored['review']['open_disagreements'], 1)
        self.assertTrue(any(row['quality']['summary']['precision'] is None
                            for row in scored['providers'].values()))
        self.decisions['rows'].append({'blind_id': self.reviews[1]['rows'][0]['blind_id'],
                                      'reviewer_id': 'reviewer-c', 'evidence_ref': 'adjudication:fixture',
                                      'comparable': True, 'verified_price_cents': 100})
        scored = evaluate(self.private, self.packet, self.reviews, self.decisions)
        self.assertEqual(scored['review']['adjudicated_disagreements'], 1)
        self.assertEqual(scored['review']['open_disagreements'], 0)
        self.decisions['rows'][0]['reviewer_id'] = 'reviewer-a'
        with self.assertRaisesRegex(ValueError, 'third reviewer'):
            evaluate(self.private, self.packet, self.reviews, self.decisions)

    def test_frozen_scope_and_packet_identity(self):
        for field, value in [('filters', {**study()['queries'][0]['filters'], 'window_days': 90}),
                             ('captured_at', '2026-11-20T17:00:00Z')]:
            value_input = study()
            value_input['snapshots'][0][field] = value
            with self.assertRaises(ValueError):
                prepare(value_input)
        self.reviews[0]['packet_sha256'] = 'c' * 64
        with self.assertRaisesRegex(ValueError, 'different packet'):
            evaluate(self.private, self.packet, self.reviews, self.decisions)

    def test_unavailable_run_is_in_the_planned_denominator(self):
        input_data = study()
        last = input_data['snapshots'].pop()
        with self.assertRaisesRegex(ValueError, 'provider run is missing'):
            prepare(input_data)
        last.update(status='unsupported', reason='history_not_supported', rows=[],
                    candidate_set_complete=False, candidate_set_hash=None)
        input_data['snapshots'].append(last)
        packet, private = prepare(input_data)
        scored = evaluate(private, packet, reviewers(packet, private['packet_sha256']),
                          {'packet_sha256': private['packet_sha256'], 'rows': []})
        peer = scored['providers']['fixture-peer']
        self.assertEqual(peer['planned_queries'], 1)
        self.assertEqual(peer['unavailable_queries']['cards-01']['reason'], 'history_not_supported')
        self.assertIsNone(peer['quality']['summary']['precision'])

    def test_cross_split_leak_and_changed_mapping_are_rejected(self):
        input_data = study()
        input_data['queries'].append({**input_data['queries'][0], 'query_id': 'cards-02', 'split': 'development'})
        input_data['snapshots'] += [{**entry, 'query_id': 'cards-02'} for entry in input_data['snapshots']]
        with self.assertRaisesRegex(ValueError, 'leaks'):
            prepare(input_data)
        self.private['snapshots'][0]['review_ids'].reverse()
        with self.assertRaisesRegex(ValueError, 'mapping changed'):
            evaluate(self.private, self.packet, self.reviews, self.decisions)

    def test_cli_writes_private_packet_and_scores_both_separate_review_files(self):
        with tempfile.TemporaryDirectory() as workspace:
            workspace = Path(workspace)
            source = workspace / 'input.json'
            source.write_text(json.dumps(study()))
            output = workspace / 'output'
            command = [sys.executable, str(ROOT / 'tools/comparison_review.py')]
            result = json.loads(subprocess.check_output([*command, 'prepare', source, output]))
            mapping = output / 'private-study.json'
            packet = output / 'review-packet.json'
            self.assertEqual(mapping.stat().st_mode & 0o777, 0o600)
            self.assertEqual(result['blind_samples'], 21)
            inputs = []
            for label, payload in zip(('review-a', 'review-b', 'decisions'),
                                      [*reviewers(json.loads(packet.read_text()), result['packet_sha256']),
                                       {'packet_sha256': result['packet_sha256'], 'rows': []}]):
                path = workspace / f'{label}.json'
                path.write_text(json.dumps(payload))
                inputs.append(path)
            evaluation = json.loads(subprocess.check_output([*command, 'evaluate', mapping, packet, *inputs]))
            self.assertEqual(evaluation['review']['agreed_reviews'], 21)
            self.assertEqual(evaluation['packet_sha256'], result['packet_sha256'])


if __name__ == '__main__':
    unittest.main()
