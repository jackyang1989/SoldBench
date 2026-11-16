#!/usr/bin/env python3
"""Report source-preparation gaps offline; never enables collection or signs GO."""
import csv
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RIGHTS = ('automatic_access', 'store_raw', 'store_derived', 'publish_stats', 'redistribute_comp', 'share', 'api_redistribution')


def prepare_report(root=ROOT):
    with (root / 'source-clearance.csv').open(newline='') as handle:
        sources = list(csv.DictReader(handle))
    with (root / 'source-capabilities.csv').open(newline='') as handle:
        fields = list(csv.DictReader(handle))
    if not sources or len({source['candidate_id'] for source in sources}) != len(sources):
        raise ValueError('Source candidates must be nonempty and unique')
    known_sources = {source['candidate_id'] for source in sources}
    if any(field['source_candidate'] not in known_sources for field in fields):
        raise ValueError('Field capability refers to an unknown source')
    gaps = []
    for source in sources:
        missing = [right for right in RIGHTS if source.get(right) != 'allowed']
        missing += [key for key in ('approved_entrypoint', 'evidence_ref', 'effective_at', 'expires_at',
                                     'rate_cap', 'concurrency_cap', 'retention_days') if not source.get(key)]
        if source.get('status') != 'APPROVED':
            missing.append('source_approval')
        if source.get('network_enabled') != 'false':
            raise ValueError('Offline preparation requires network_enabled=false')
        selected = [field for field in fields if field['source_candidate'] == source['candidate_id']]
        unverified = [field['field'] for field in selected
                      if field['availability'] != 'available_verified' or not field['evidence_ref']]
        gaps.append({'source': source['candidate_id'], 'missingRightsOrTerms': missing,
                     'unverifiedFields': unverified, 'fieldChecklistPresent': bool(selected)})
    digests = {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
               for name in ('source-clearance.csv', 'source-capabilities.csv')}
    return {'schema': 'soldbench.preparation-report.v1', 'mode': 'offline_fixture', 'collectorEnabled': False,
            'status': 'REQUIRES_EXTERNAL_REVIEW', 'stageVerdict': 'NOT_ISSUED',
            'gaps': gaps, 'sha256': digests, 'approvalEvidenceValidated': False}


if __name__ == '__main__':
    print(json.dumps(prepare_report(), indent=2))
