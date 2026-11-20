import copy
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from full_quota_cost import project

FIXTURE = ROOT / 'unit-economics' / 'full-quota-fixture.json'


class FullQuotaCostTests(unittest.TestCase):
    def setUp(self):
        self.input = json.loads(FIXTURE.read_text())

    def test_full_quota_keeps_fractional_weights_and_paid_tail(self):
        report = project(self.input)
        self.assertEqual(report['status'], 'CALCULATED')
        self.assertEqual(report['forecast'], 'full_quota_projection')
        self.assertEqual(report['projected_variable_costs']['network_cash_cents'],
                         {'numerator': '239', 'denominator': '6', 'rounded_cents': 40})
        charged = report['variable_cost_per_charged_unit']
        self.assertEqual(charged['p50']['denominator'], '4')
        self.assertEqual(charged['p95']['rounded_cents'], 2)
        self.assertEqual(charged['worst_5_percent_average']['rounded_cents'], 4)
        self.assertEqual(report['monthly_finance']['metrics']['variable_cash_cost'],
                         report['projected_variable_costs']['network_cash_cents'])
        self.assertFalse(report['priceApproved'])

    def test_unknown_unit_or_missing_positive_stratum_keeps_cost_unknown(self):
        for missing_source in ('stratum', 'category', 'finance'):
            with self.subTest(missing_source=missing_source):
                value = copy.deepcopy(self.input)
                if missing_source == 'stratum':
                    value['observations'].pop()
                elif missing_source == 'category':
                    value['observations'][-1]['costs']['compute_cash_cents'] = None
                else:
                    value['monthly_finance']['costs']['infra_cash_cents'] = None
                report = project(value)
                self.assertEqual(report['status'], 'INCOMPLETE')
                self.assertIsNone(report['monthly_finance']['metrics'])
                if missing_source != 'finance':
                    self.assertIsNone(report['variable_cost_per_charged_unit']['p95'])
                    self.assertIsNone(report['projected_variable_costs'])

    def test_replay_duplicate_unit_changed_quota_and_double_count_are_rejected(self):
        for field, pattern in [('duplicate', 'repeats'), ('quota', 'must match'), ('preloaded', 'must not be prefilled'),
                               ('outside', 'outside the measurement window')]:
            with self.subTest(field=field):
                value = copy.deepcopy(self.input)
                if field == 'duplicate':
                    value['observations'].append(copy.deepcopy(value['observations'][0]))
                elif field == 'quota':
                    value['plan']['credits_per_customer'] += 1
                elif field == 'preloaded':
                    value['monthly_finance']['costs']['network_cash_cents'] = '0'
                else:
                    value['observations'][0]['observed_at'] = value['observed_until']
                with self.assertRaisesRegex(ValueError, pattern):
                    project(value)

    def test_measured_observations_require_provenance_and_remain_a_projection(self):
        value = self.input
        value['evidence_kind'] = value['monthly_finance']['evidence_kind'] = 'measured'
        value['evidence_ref'] = value['monthly_finance']['evidence_ref'] = 'local:regression-fixture'
        with self.assertRaisesRegex(ValueError, 'projected workload weight'):
            project(value)
        for row in value['workload']:
            row['projection_ref'] = 'local:quota-mix'
        with self.assertRaisesRegex(ValueError, 'Measured unit requires'):
            project(value)
        for row in value['observations']:
            row['evidence_ref'] = 'local:unit-worksheet'
        result = project(value)
        self.assertEqual(result['forecast'], 'full_quota_projection')
        self.assertEqual(result['stageVerdict'], 'NOT_ISSUED')

    def test_command_line_reads_the_shared_fixture(self):
        command = [sys.executable, str(ROOT / 'tools/full_quota_cost.py'), str(FIXTURE)]
        result = subprocess.run(command, check=True, capture_output=True, text=True)
        self.assertEqual(json.loads(result.stdout), project(self.input))
