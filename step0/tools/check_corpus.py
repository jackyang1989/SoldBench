#!/usr/bin/env python3
"""Validate the draft query corpus offline. Human labels and signoff stay pending."""
import csv
import hashlib
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GROUPS = {'cards', 'sneakers', 'watches', 'video_games', 'gpu_hardware', 'collectibles'}


def check():
    corpus = ROOT / 'corpus.csv'
    with corpus.open(newline='') as handle:
        rows = list(csv.DictReader(handle))
    assert len(rows) == 120, 'Expected 120 queries'
    assert len({row['id'] for row in rows}) == 120, 'Duplicate query ID'
    assert len({row['keyword'].casefold() for row in rows}) == 120, 'Duplicate query'
    assert Counter((row['group'], row['tier']) for row in rows) == Counter({
        (group, tier): 10 for group in GROUPS for tier in ('head', 'tail')})
    for row in rows:
        assert 1 <= len(row['keyword']) <= 120
        attrs = json.loads(row['expected_attrs'])
        assert all(isinstance(attrs.get(key), str) and attrs[key].strip()
                   for key in ('kind', 'model', 'required_variant'))
        assert row['ground_truth_notes'].startswith('DRAFT_UNLABELED;')
    manifest = json.loads((ROOT / 'corpus-manifest.json').read_text())
    digest = hashlib.sha256(corpus.read_bytes()).hexdigest()
    assert manifest['sha256'] == digest, 'Corpus changed without manifest review'
    assert manifest['status'] == 'DRAFT_UNLABELED' and manifest['founderSignedAt'] is None
    with (ROOT / 'labels/template.csv').open() as handle:
        assert not list(csv.DictReader(handle)), 'Template must not contain invented labels'
    return {'result': 'PASS', 'scope': 'draft_structure_only', 'queries': 120, 'sha256': digest,
            'humanLabels': 0, 'founderSigned': False, 'onlineVerified': False}


if __name__ == '__main__':
    print(json.dumps(check(), indent=2))
