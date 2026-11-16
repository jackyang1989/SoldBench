import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from quality_report import report, wilson


class QualityTests(unittest.TestCase):
    def dataset(self, count=10):
        ids = ['synthetic/event-' + str(i) for i in range(count)]
        return {'schema': 'soldbench.quality-input.v1', 'evidence_kind': 'synthetic',
                'snapshots': [{'query_id': 'cards-01', 'candidate_ids': ids, 'candidate_set_hash': 'a' * 64,
                               'candidate_set_complete': True, 'split': 'development', 'evidence_ref': None}],
                'rows': [{'query_id': 'cards-01', 'candidate_id': event, 'gold_comparable': True,
                          'predicted_comparable': True, 'gold_price_cents': 100, 'predicted_price_cents': 110}
                         for event in ids]}

    def test_empty_dataset_keeps_unknown_metrics(self):
        data = self.dataset(0)
        data['snapshots'] = []
        value = report(data)
        self.assertIsNone(value['summary']['precision'])
        self.assertIsNone(value['summary']['recall_within_candidate_snapshot'])
        self.assertIsNone(value['quality_score'])
        self.assertFalse(value['releaseApproved'])

    def test_known_confusion_matrix_and_wilson_interval(self):
        data = self.dataset()
        data['rows'][0]['gold_comparable'] = False
        data['rows'][1]['predicted_comparable'] = False
        data['rows'][2].update(gold_comparable=False, predicted_comparable=False)
        value = report(data)['summary']
        self.assertEqual([value[key] for key in ('tp', 'fp', 'fn', 'tn')], [7, 1, 1, 1])
        self.assertEqual(value['precision'], 7 / 8)
        self.assertEqual(value['recall_within_candidate_snapshot'], 7 / 8)
        interval = wilson(100, 100)
        self.assertAlmostEqual(interval['low'], 0.9630065017930143)
        self.assertAlmostEqual(interval['high'], 1)
        self.assertIsNone(wilson(0, 0))

    def test_missing_or_unknown_gold_cannot_improve_metrics(self):
        for missing in (True, False):
            data = self.dataset()
            if missing:
                data['rows'].pop()
            else:
                data['rows'][0]['gold_comparable'] = None
            value = report(data)['summary']
            self.assertIsNone(value['precision'])
            self.assertIsNone(value['recall_within_candidate_snapshot'])
        data = self.dataset()
        data['snapshots'][0]['candidate_set_complete'] = False
        self.assertIsNone(report(data)['summary']['recall_within_candidate_snapshot'])

    def test_median_price_error_and_zero_or_small_sample(self):
        value = report(self.dataset())['by_query']['cards-01']
        self.assertEqual(value['median_absolute_relative_error'], {'numerator': '1', 'denominator': '10'})
        self.assertIsNone(report(self.dataset(7))['by_query']['cards-01']['median_absolute_relative_error'])
        data = self.dataset()
        for row in data['rows']:
            row['gold_price_cents'] = 0
        self.assertIsNone(report(data)['by_query']['cards-01']['median_absolute_relative_error'])

    def test_event_leakage_duplicate_rows_unplanned_labels_and_bad_money(self):
        data = self.dataset()
        leaked = copy.deepcopy(data)
        leaked['snapshots'].append({**leaked['snapshots'][0], 'query_id': 'cards-02', 'split': 'holdout'})
        with self.assertRaisesRegex(ValueError, 'leaks'):
            report(leaked)
        for changes in [{'candidate_id': 'unplanned'}, {'gold_price_cents': 0.5}, {'gold_comparable': 1}]:
            value = copy.deepcopy(data)
            value['rows'][0].update(changes)
            with self.assertRaises(ValueError):
                report(value)
        data['rows'].append(data['rows'][0])
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            report(data)

    def test_human_label_mode_requires_distinct_reviewers_and_refs(self):
        data = self.dataset()
        data['evidence_kind'] = 'human_adjudicated'
        with self.assertRaises(ValueError):
            report(data)
        data['snapshots'][0]['evidence_ref'] = 'synthetic-test-controlled-ref'
        for row in data['rows']:
            row.update(annotator_ids=['reviewer-1', 'reviewer-2'], adjudication_ref='synthetic-test-adjudication')
        self.assertFalse(report(data)['externalEvidenceVerified'])
        data['rows'][0]['annotator_ids'] = ['same', 'same']
        with self.assertRaises(ValueError):
            report(data)


if __name__ == '__main__':
    unittest.main()
