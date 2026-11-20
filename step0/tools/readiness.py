#!/usr/bin/env python3
"""Report source-preparation gaps offline; never enables collection or signs GO."""
import csv
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RIGHTS = ('automatic_access', 'store_raw', 'store_derived', 'publish_stats', 'redistribute_comp', 'share', 'api_redistribution')
MEDIA_RIGHTS = ('media_capture', 'media_store', 'media_process', 'media_display', 'media_redistribution')
PRIMARY_FIELDS = ('primary_image_candidate', 'primary_image_role', 'primary_image_evidence_binding', 'primary_image_dimensions')
EBAY_US_FIELDS = (
    'listing_id', 'sale_event_id', 'event_identity_evidence', 'sold_status', 'sold_at',
    'source_time_zone', 'sold_date_precision', 'sale_price_status', 'item_price', 'currency',
    'observed_shipping', 'shipping_destination', 'sale_format', 'condition', 'category',
    'strong_attributes', 'next_cursor', 'sort_order', 'source_as_of', 'retention_until',
    'title', 'listing_url', 'condition_id', 'condition_raw', 'condition_mapping_context',
    'displayed_price', 'accepted_offer_evidence', 'shipping_status', 'shipping_evidence',
    'shipping_context', *PRIMARY_FIELDS, 'seller_source_identity', 'seller_public_handle',
    'source_reported_match_count', 'source_reported_match_count_context', 'source_record_unit',
    'query_capture_context', 'item_specifics', 'condition_description', 'description',
    'gallery_images', 'field_visibility_permissions',
)
FIELD_RIGHTS_TERMS = (
    'approved_field_entrypoint', 'rights_evidence_ref', 'approved_uses', 'region',
    'rights_effective_at', 'rights_expires_at', 'retention_days', 'revocation_trigger',
    'cleanup_owner_role', 'approval_status',
)


def has_text(value):
    return bool(value and value.strip())


def field_verified(field):
    return (field['availability'] == 'available_verified' and has_text(field.get('evidence_ref'))
            and has_text(field.get('parser_version')))


def missing_field_rights(field):
    placeholders = {'unknown', 'unverified', 'pending_evidence'}
    return [key for key in FIELD_RIGHTS_TERMS
            if not has_text(field.get(key)) or field[key].strip().lower() in placeholders]


def prepare_report(root=ROOT):
    with (root / 'source-clearance.csv').open(newline='') as handle:
        sources = list(csv.DictReader(handle))
    with (root / 'source-capabilities.csv').open(newline='') as handle:
        fields = list(csv.DictReader(handle))
    if not sources or len({source['candidate_id'] for source in sources}) != len(sources):
        raise ValueError('Source candidates must be nonempty and unique')
    known_sources = {source['candidate_id'] for source in sources}
    by_source = {source: {} for source in known_sources}
    for field in fields:
        source, name = field['source_candidate'], field['field']
        if source not in by_source or not has_text(name) or name in by_source[source]:
            raise ValueError('Field capabilities require a known source and unique field names')
        by_source[source][name] = field
    gaps = []
    for source in sources:
        missing = [right for right in RIGHTS if source.get(right) != 'allowed']
        missing += [key for key in ('approved_entrypoint', 'evidence_ref', 'effective_at', 'expires_at',
                                     'rate_cap', 'concurrency_cap', 'retention_days')
                    if not has_text(source.get(key))]
        if source.get('status') != 'APPROVED':
            missing.append('source_approval')
        if source.get('network_enabled') != 'false':
            raise ValueError('Offline preparation requires network_enabled=false')
        selected = by_source[source['candidate_id']]
        expected = EBAY_US_FIELDS if source.get('marketplace') == 'ebay_us' else None
        missing_fields = [name for name in expected or () if name not in selected]
        unverified = [name for name, field in selected.items() if not field_verified(field)]
        field_rights = {name: terms for name, field in selected.items()
                        if (terms := missing_field_rights(field))}
        media_missing = [right for right in MEDIA_RIGHTS if source.get(right) != 'allowed']
        if not re.fullmatch(r'[1-9][0-9]*', source.get('media_retention_days') or ''):
            media_missing.append('media_retention_days')
        if not has_text(source.get('media_evidence_ref')):
            media_missing.append('media_evidence_ref')
        gaps.append({'source': source['candidate_id'], 'missingRightsOrTerms': missing,
                     'unverifiedFields': unverified, 'fieldChecklistPresent': bool(selected),
                     'expectedFieldCount': len(expected) if expected is not None else None,
                     'recordedFieldCount': len(selected),
                     'fieldChecklistComplete': expected is not None and not missing_fields,
                     'missingFields': missing_fields, 'fieldRightsGaps': field_rights,
                     'primaryImages': {
                         'missingRightsOrTerms': media_missing,
                         'missingFields': [name for name in PRIMARY_FIELDS if name not in selected],
                         'unverifiedFields': [name for name in PRIMARY_FIELDS if name in unverified],
                     }})
    digests = {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
               for name in ('source-clearance.csv', 'source-capabilities.csv')}
    return {'schema': 'soldbench.preparation-report.v1', 'mode': 'offline_fixture', 'collectorEnabled': False,
            'status': 'REQUIRES_EXTERNAL_REVIEW', 'stageVerdict': 'NOT_ISSUED',
            'gaps': gaps, 'sha256': digests, 'approvalEvidenceValidated': False}


if __name__ == '__main__':
    print(json.dumps(prepare_report(), indent=2))
