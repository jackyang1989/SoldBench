import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from stability_report import plan, summarize


class StabilityTests(unittest.TestCase):
    def tasks(self):
        return plan('2026-12-01')

    def row(self, task):
        return {'task_id': task['task_id'], 'mode': 'offline_fixture',
                'started_at': task['scheduled_at'], 'finished_at': task['scheduled_at'],
                'attempts': 2, 'first_semantic_success': True, 'semantic_success': True, 'billable': True,
                'pages': 2, 'bytes': 1000, 'cpu_ms': 10, 'cost_cents': '0.25', 'evidence_ref': None}

    def test_plan_1680_balanced_slots_and_preserves_missing_denominator(self):
        tasks = self.tasks()
        self.assertEqual(len(tasks), 1680)
        for hour in ('00', '08', '16'):
            self.assertEqual(sum(task['scheduled_at'][11:13] == hour for task in tasks), 560)
        report = summarize(tasks, [])
        self.assertEqual(report['summary']['planned'], 1680)
        self.assertEqual(report['summary']['missing'], 1680)
        self.assertIsNone(report['summary']['plan_total_cost_cents'])
        self.assertEqual(report['days_with_all_planned_terminal_records'], 0)

    def test_retries_final_success_and_failed_cost_are_preserved(self):
        tasks = self.tasks()
        rows = [self.row(task) for task in tasks[:3]]
        rows[1].update(attempts=4, first_semantic_success=False)
        rows[2].update(first_semantic_success=False, semantic_success=False, billable=False, cost_cents='2')
        report = summarize(tasks, rows)
        summary = report['summary']
        self.assertEqual(summary['first_semantic_success'], 1)
        self.assertEqual(summary['final_semantic_success'], 2)
        self.assertEqual(summary['started'], 3)
        self.assertEqual(summary['first_success_rate'], 1 / 1680)
        self.assertEqual(summary['observed_known_cost_cents']['numerator'], '5')
        self.assertEqual(summary['observed_known_cost_cents']['denominator'], '2')
        self.assertEqual(summary['observed_cost_distribution']['p95_cents']['numerator'], '73')
        self.assertEqual(summary['observed_cost_distribution']['p95_cents']['denominator'], '40')
        self.assertEqual(summary['observed_cost_distribution']['worst_5pct_mean_cents']['rounded_cents'], 2)

    def test_full_offline_plan_does_not_claim_external_verification(self):
        tasks = self.tasks()
        report = summarize(tasks, [self.row(task) for task in tasks])
        self.assertEqual(report['days_with_all_planned_terminal_records'], 14)
        self.assertEqual(report['mode'], 'offline_fixture')
        self.assertFalse(report['externalEvidenceVerified'])
        self.assertEqual(report['stageVerdict'], 'NOT_ISSUED')

    def test_rejects_duplicate_unplanned_invalid_times_budget_and_boolean(self):
        tasks = self.tasks()
        row = self.row(tasks[0])
        for changes in [{'task_id': 'unknown'}, {'attempts': 0}, {'attempts': 1}, {'semantic_success': 1},
                        {'semantic_success': False}, {'started_at': '2026-12-02T00:00:00Z'},
                        {'finished_at': '2026-11-30T00:00:00Z'}, {'bytes': -1}, {'cost_cents': -1}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                summarize(tasks, [{**row, **changes}])
        with self.assertRaises(ValueError):
            summarize(tasks, [row, row])

    def test_pre_dispatch_stop_is_a_started_failure_with_zero_requests(self):
        tasks = self.tasks()
        row = self.row(tasks[0])
        row.update(attempts=0, first_semantic_success=False, semantic_success=False, billable=False, pages=0, bytes=0)
        result = summarize(tasks, [row])['summary']
        self.assertEqual(result['started'], 1)
        self.assertEqual(result['attempts'], 0)
        self.assertEqual(result['final_semantic_success'], 0)

    def test_online_reference_and_mode_separation(self):
        tasks = self.tasks()
        row = self.row(tasks[0])
        row['mode'] = 'authorized_online'
        with self.assertRaisesRegex(ValueError, 'evidence'):
            summarize(tasks, [row])
        row['evidence_ref'] = 'synthetic-unit-test-evidence-only'
        self.assertFalse(summarize(tasks, [row])['externalEvidenceVerified'])
        with self.assertRaisesRegex(ValueError, 'mixed'):
            summarize(tasks, [row, self.row(tasks[1])])


if __name__ == '__main__':
    unittest.main()
