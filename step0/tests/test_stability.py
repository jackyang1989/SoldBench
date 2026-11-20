import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from stability_report import campaign_plan, plan, summarize


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
                        {'started_at': '2026-12-01Z'}, {'started_at': '2026-12-01 00:00:00Z'},
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

    def test_semantic_success_requires_page_evidence_and_first_pass_has_no_retries(self):
        tasks = self.tasks()
        row = self.row(tasks[0])
        with self.assertRaisesRegex(ValueError, 'requires at least one committed page'):
            summarize(tasks, [{**row, 'pages': 0}])
        with self.assertRaisesRegex(ValueError, 'First-pass success cannot include extra page attempts'):
            summarize(tasks, [{**row, 'attempts': 3}])
        empty_valid_page = {**row, 'pages': 1, 'attempts': 1, 'billable': False}
        self.assertEqual(summarize(tasks, [empty_valid_page])['summary']['first_semantic_success'], 1)
        self.assertEqual(summarize(tasks, [{**row, 'attempts': 3, 'first_semantic_success': False}])
                         ['summary']['final_semantic_success'], 1)

    def test_online_reference_and_mode_separation(self):
        tasks = self.tasks()
        digest = campaign_plan('2026-12-01')['campaign_sha256']
        row = self.row(tasks[1])
        row['mode'] = 'authorized_online'
        with self.assertRaisesRegex(ValueError, 'evidence'):
            summarize(tasks, [row])
        row['evidence_ref'] = 'synthetic-unit-test-evidence-only'
        with self.assertRaisesRegex(ValueError, 'campaign digest'):
            summarize(tasks, [row], digest)
        row['campaign_sha256'] = digest
        self.assertFalse(summarize(tasks, [row], digest)['externalEvidenceVerified'])
        too_early = {**row, 'started_at': '2026-12-01T07:59:59Z'}
        with self.assertRaisesRegex(ValueError, 'before its frozen UTC slot'):
            summarize(tasks, [too_early], digest)
        with self.assertRaisesRegex(ValueError, 'mixed'):
            summarize(tasks, [row, self.row(tasks[0])], digest)

    def test_cli_rejects_changed_campaign_or_corpus_and_requires_freeze_for_online_rows(self):
        with tempfile.TemporaryDirectory(prefix='soldbench-stability-campaign-') as directory:
            root = Path(directory)
            saved, corpus, results = (root / name for name in ('plan.json', 'corpus.csv', 'results.jsonl'))
            original = (ROOT / 'corpus.csv').read_bytes()
            corpus.write_bytes(original)

            def cli(*args):
                return subprocess.run([sys.executable, str(ROOT / 'tools/stability_report.py'),
                                       '--corpus', str(corpus), *map(str, args)], capture_output=True, text=True)

            start = ('--start', '2026-12-01')
            exported = cli(*start, '--freeze-plan', saved)
            self.assertEqual(exported.returncode, 0, exported.stderr)
            manifest = json.loads(saved.read_text())
            self.assertEqual(manifest['campaign_sha256'], exported.stdout.strip())
            self.assertEqual(len(manifest['tasks']), 1680)
            self.assertNotEqual(cli(*start, '--freeze-plan', saved).returncode, 0)
            results.write_text(json.dumps({**self.row(manifest['tasks'][0]), 'mode': 'authorized_online',
                                           'campaign_sha256': manifest['campaign_sha256'],
                                           'evidence_ref': 'synthetic-controlled-ref'}) + '\n')
            self.assertNotEqual(cli(*start, '--results', results).returncode, 0)
            result = cli('--plan', saved, '--results', results)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report['summary']['missing'], 1679)
            self.assertEqual(report['stageVerdict'], 'NOT_ISSUED')
            self.assertFalse(report['externalEvidenceVerified'])
            original_results = results.read_bytes()
            expected_digest = hashlib.sha256(original_results).hexdigest()
            self.assertEqual(report['results_sha256'], expected_digest)
            self.assertEqual(cli('--plan', saved, '--results', results,
                                 '--expect-results-sha256', expected_digest).returncode, 0)
            results.write_bytes(original_results + b'\n')
            changed_results = cli('--plan', saved, '--results', results,
                                  '--expect-results-sha256', expected_digest)
            self.assertNotEqual(changed_results.returncode, 0)
            self.assertIn('independently recorded digest', changed_results.stderr)
            results.write_bytes(original_results.replace(b'"pages": ', b'"pages": 0, "pages": '))
            duplicate = cli('--plan', saved, '--results', results)
            self.assertNotEqual(duplicate.returncode, 0)
            self.assertIn('Duplicate JSON property: pages', duplicate.stderr)
            results.write_bytes(original_results)
            corpus.write_bytes(original.replace(b'Charizard', b'Another model', 1))
            wrong_corpus = cli('--plan', saved, '--results', results)
            self.assertNotEqual(wrong_corpus.returncode, 0)
            self.assertIn('differs from the frozen manifest', wrong_corpus.stderr)
            corpus.write_bytes(original)
            manifest['tasks'].pop()
            saved.write_text(json.dumps(manifest))
            wrong_plan = cli('--plan', saved, '--results', results)
            self.assertNotEqual(wrong_plan.returncode, 0)
            self.assertIn('differs from the frozen manifest', wrong_plan.stderr)


if __name__ == '__main__':
    unittest.main()
