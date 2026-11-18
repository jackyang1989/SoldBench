import csv
import json
import sys
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from unit_economics import calculate
from readiness import MEDIA_RIGHTS, PRIMARY_FIELDS, RIGHTS, prepare_report


class PreparationTests(unittest.TestCase):
    def scenario(self):
        return json.loads((ROOT / 'unit-economics/scenarios.json').read_text())[1]

    def test_unknown_costs_remain_unknown(self):
        value = json.loads((ROOT / 'unit-economics/unmeasured.json').read_text())
        report = calculate(value)
        self.assertEqual(report['status'], 'INCOMPLETE')
        self.assertIsNone(report['metrics'])
        self.assertIn('costs.access_license_cash_cents', report['missing'])

    def test_net_proceeds_and_full_cost_by_independent_hand_calculation(self):
        value = self.scenario()
        report = calculate(value)
        metrics = report['metrics']
        # 100 * 2900 * .93 - 100 * 50 = 264700 cents.
        self.assertEqual(metrics['net_proceeds']['rounded_cents'], 264700)
        self.assertEqual(metrics['full_cost']['rounded_cents'], 160000)
        self.assertEqual(metrics['economic_profit']['rounded_cents'], 104700)
        self.assertEqual(metrics['minimum_price_cents_for_target_margin'], 3495)
        self.assertEqual(metrics['cash_break_even_customers_at_current_mix'], 15)
        self.assertFalse(report['priceApproved'])
        self.assertFalse(report['stabilityVerified'])
        self.assertEqual(report['evidence_kind'], 'assumed')

    def test_price_floor_rounds_up_and_achieves_target(self):
        value = self.scenario()
        floor = calculate(value)['metrics']['minimum_price_cents_for_target_margin']
        value['gross_price_cents'] = str(floor)
        margin = calculate(value)['metrics']['fully_loaded_margin']
        self.assertGreaterEqual(Fraction(int(margin['numerator']), int(margin['denominator'])), Fraction(1, 2))
        value['gross_price_cents'] = str(floor - 1)
        margin = calculate(value)['metrics']['fully_loaded_margin']
        self.assertLess(Fraction(int(margin['numerator']), int(margin['denominator'])), Fraction(1, 2))

    def test_zero_denominators_and_negative_margin(self):
        value = self.scenario()
        value.update(customers=0, billable_queries=0, payment_transactions=0)
        metrics = calculate(value)['metrics']
        self.assertIsNone(metrics['fully_loaded_margin'])
        self.assertIsNone(metrics['full_cost_per_billable_query'])
        self.assertIsNone(metrics['cash_break_even_customers_at_current_mix'])
        value = self.scenario()
        value['costs']['network_cash_cents'] = '1000000'
        metrics = calculate(value)['metrics']
        self.assertLess(metrics['economic_profit']['rounded_cents'], 0)
        self.assertIsNone(metrics['cash_break_even_customers_at_current_mix'])

    def test_failed_and_free_costs_change_full_cost_without_changing_billed_count(self):
        value = self.scenario()
        old = calculate(value)['metrics']
        value['costs']['network_cash_cents'] = '40001.5'
        new = calculate(value)['metrics']
        self.assertEqual(new['full_cost']['rounded_cents'], old['full_cost']['rounded_cents'] + 2)
        self.assertEqual(new['full_cost_per_billable_query']['numerator'], '320003')
        self.assertEqual(new['full_cost_per_billable_query']['denominator'], '500000')

    def test_invalid_rates_counts_cents_evidence_and_categories(self):
        changes = [dict(customers=True), dict(customers=-1), dict(gross_price_cents='1.5'),
                   dict(payment_rate='NaN'), dict(payment_rate=0.05), dict(target_margin='1'),
                   dict(payment_rate='0.98'), dict(evidence_kind='measured'),
                   dict(customers=0), dict(costs={**self.scenario()['costs'], 'duplicate_total': '1'})]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(ValueError):
                calculate({**self.scenario(), **change})

    def test_source_report_keeps_missing_rights_and_fields(self):
        report = prepare_report()
        self.assertFalse(report['collectorEnabled'])
        self.assertEqual(report['stageVerdict'], 'NOT_ISSUED')
        self.assertIn('automatic_access', report['gaps'][0]['missingRightsOrTerms'])
        self.assertIn('sale_event_id', report['gaps'][0]['unverifiedFields'])
        images = report['gaps'][0]['primaryImages']
        self.assertTrue(set(MEDIA_RIGHTS).issubset(images['missingRightsOrTerms']))
        self.assertEqual(images['missingFields'], [])
        self.assertEqual(set(images['unverifiedFields']), set(PRIMARY_FIELDS))

    def test_media_permission_and_primary_evidence_are_independent(self):
        def read(name):
            with (ROOT / name).open(newline='') as handle:
                reader = csv.DictReader(handle)
                return reader.fieldnames, list(reader)

        def write(root, name, columns, rows):
            with (root / name).open('w', newline='') as handle:
                writer = csv.DictWriter(handle, fieldnames=columns)
                writer.writeheader()
                writer.writerows(rows)

        with tempfile.TemporaryDirectory(prefix='soldbench-media-readiness-') as directory:
            root = Path(directory)
            sc, sources = read('source-clearance.csv')
            fc, fields = read('source-capabilities.csv')
            source = sources[0]
            source.update({right: 'allowed' for right in RIGHTS})
            source.update({right: 'allowed' for right in MEDIA_RIGHTS if right != 'media_redistribution'})
            source.update(media_retention_days='0', media_evidence_ref='  ')
            write(root, 'source-clearance.csv', sc, sources)
            for field in fields:
                if field['field'] in PRIMARY_FIELDS:
                    field.update(availability='available_verified', evidence_ref='mock-signed-terms')
            incomplete = [field for field in fields if field['field'] != 'primary_image_dimensions']
            write(root, 'source-capabilities.csv', fc, incomplete)
            initial = prepare_report(root)['gaps'][0]['primaryImages']
            self.assertEqual(initial['missingRightsOrTerms'],
                             ['media_redistribution', 'media_retention_days', 'media_evidence_ref'])
            self.assertEqual(initial['missingFields'], ['primary_image_dimensions'])
            self.assertIn('primary_image_evidence_binding', initial['unverifiedFields'])

            source.update(media_redistribution='allowed', media_retention_days='7',
                          media_evidence_ref='mock-signed-terms')
            write(root, 'source-clearance.csv', sc, sources)
            for field in fields:
                if field['field'] in PRIMARY_FIELDS:
                    field['parser_version'] = 'synthetic-review-v1'
            write(root, 'source-capabilities.csv', fc, fields)
            report = prepare_report(root)
            self.assertEqual(report['gaps'][0]['primaryImages'],
                             {'missingRightsOrTerms': [], 'missingFields': [], 'unverifiedFields': []})
            self.assertFalse(report['approvalEvidenceValidated'])
            self.assertFalse(report['collectorEnabled'])
            self.assertEqual(report['stageVerdict'], 'NOT_ISSUED')

    def test_preparation_rejects_network_enabled(self):
        with tempfile.TemporaryDirectory(prefix='soldbench-readiness-') as directory:
            root = Path(directory)
            for name in ('source-clearance.csv', 'source-capabilities.csv'):
                (root / name).write_bytes((ROOT / name).read_bytes())
            path = root / 'source-clearance.csv'
            with path.open(newline='') as handle:
                reader = csv.DictReader(handle)
                columns, rows = reader.fieldnames, list(reader)
            rows[0]['network_enabled'] = 'true'
            with path.open('w', newline='') as handle:
                writer = csv.DictWriter(handle, fieldnames=columns)
                writer.writeheader(); writer.writerows(rows)
            with self.assertRaisesRegex(ValueError, 'network_enabled'):
                prepare_report(root)


if __name__ == '__main__':
    unittest.main()
