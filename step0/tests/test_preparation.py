import csv
from datetime import datetime, timezone
import hashlib
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
        gap = report['gaps'][0]
        self.assertIn('automatic_access', gap['missingRightsOrTerms'])
        self.assertIn('sale_event_id', gap['unverifiedFields'])
        self.assertEqual(gap['expectedFieldCount'], 45)
        self.assertEqual(gap['recordedFieldCount'], 45)
        self.assertTrue(gap['fieldChecklistComplete'])
        self.assertEqual(gap['missingFields'], [])
        self.assertIn('approved_uses', gap['fieldRightsGaps']['sale_event_id'])
        images = gap['primaryImages']
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
            incomplete = [field for field in fields
                          if field['field'] not in {'primary_image_dimensions', 'sale_event_id'}]
            write(root, 'source-capabilities.csv', fc, incomplete)
            gap = prepare_report(root)['gaps'][0]
            self.assertFalse(gap['fieldChecklistComplete'])
            self.assertEqual(gap['recordedFieldCount'], 43)
            self.assertEqual(gap['missingFields'], ['sale_event_id', 'primary_image_dimensions'])
            self.assertNotIn('sale_event_id', gap['unverifiedFields'])
            initial = gap['primaryImages']
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
            self.assertIn('rights_evidence_ref',
                          report['gaps'][0]['fieldRightsGaps']['primary_image_evidence_binding'])
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

    def test_source_and_fields_report_invalid_or_expired_terms_from_the_exact_csv_bytes(self):
        def write(root, name, update):
            with (ROOT / name).open(newline='') as handle:
                reader = csv.DictReader(handle)
                columns, rows = reader.fieldnames, list(reader)
            update(rows)
            target = root / name
            with target.open('w', encoding='utf-8-sig', newline='') as handle:
                writer = csv.DictWriter(handle, fieldnames=columns)
                writer.writeheader()
                writer.writerows(rows)
            return hashlib.sha256(target.read_bytes()).hexdigest()

        def source(rows):
            rows[0].update(status='APPROVED', approved_entrypoint='test-entrypoint',
                           evidence_ref='unknown', rate_cap='0', concurrency_cap='3.5', retention_days='8',
                           allowed_access_method='offline_fixture', effective_at='2026-01-01T00:00:00Z',
                           expires_at='2026-11-21T00:00:00+00:00')

        def fields(rows):
            rows[0].update(rights_effective_at='2025-12-31T23:59:59Z',
                           rights_expires_at='2027-01-01T00:00:00Z',
                           retention_days='-1', approval_status='revoked')
            rows[1].update(rights_effective_at='2026-02-30T00:00:00Z',
                           rights_expires_at='2026-11-21T00:00:00-07:00')
            rows[2].update(rights_effective_at='2026-06-01T00:00:00Z',
                           rights_expires_at='2026-05-01T00:00:00Z', retention_days='0')

        with tempfile.TemporaryDirectory(prefix='soldbench-readiness-terms-') as directory:
            root = Path(directory)
            source_name = 'source-clearance.csv'
            field_name = 'source-capabilities.csv'
            expected = {source_name: write(root, source_name, source), field_name: write(root, field_name, fields)}
            report = prepare_report(root, as_of=datetime(2026, 11, 21, tzinfo=timezone.utc))
            self.assertEqual(report['sha256'], expected)
            self.assertFalse(report['approvalEvidenceValidated'])
            self.assertFalse(report['collectorEnabled'])
            self.assertEqual(report['stageVerdict'], 'NOT_ISSUED')
            gap = report['gaps'][0]
            self.assertIn('evidence_ref', gap['missingRightsOrTerms'])
            self.assertEqual(gap['sourceTermIssues'], {
                'expires_at': 'expired', 'rate_cap': 'positive_integer_required',
                'concurrency_cap': 'positive_integer_required', 'allowed_access_method': 'offline_fixture_only',
            })
            self.assertEqual(gap['fieldTermIssues']['listing_id'], {
                'rights_effective_at': 'starts_before_source', 'rights_expires_at': 'extends_past_source',
                'retention_days': 'nonnegative_integer_required', 'approval_status': 'inactive',
            })
            self.assertEqual(gap['fieldTermIssues']['sale_event_id'], {
                'rights_effective_at': 'utc_timestamp_required', 'rights_expires_at': 'utc_timestamp_required',
            })
            self.assertEqual(gap['fieldTermIssues']['event_identity_evidence'],
                             {'rights_expires_at': 'must_follow_effective_at'})

    def test_preparation_does_not_silently_drop_duplicate_headers_or_extra_cells(self):
        with tempfile.TemporaryDirectory(prefix='soldbench-readiness-csv-') as directory:
            root = Path(directory)
            name = 'source-clearance.csv'
            rows = (ROOT / name).read_text().splitlines()
            (root / name).write_text(f'{rows[0]},status\n{rows[1]},APPROVED\n')
            with self.assertRaisesRegex(ValueError, 'duplicate headers'):
                prepare_report(root)
            (root / name).write_text(f'{rows[0]}\n{rows[1]},APPROVED\n')
            with self.assertRaisesRegex(ValueError, 'inconsistent row length'):
                prepare_report(root)


if __name__ == '__main__':
    unittest.main()
