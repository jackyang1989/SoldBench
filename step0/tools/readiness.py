#!/usr/bin/env python3
"""Report source-preparation gaps offline; never enables collection or signs GO."""
import csv
from datetime import datetime, timedelta, timezone
import hashlib
import io
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
SOURCE_TERMS = ('approved_entrypoint', 'allowed_access_method', 'evidence_ref',
                'effective_at', 'expires_at', 'rate_cap', 'concurrency_cap', 'retention_days')
PLACEHOLDERS = {'unknown', 'unverified', 'pending_evidence'}


def has_text(value):
    return bool(value and value.strip())


def known(value):
    return has_text(value) and value.strip().lower() not in PLACEHOLDERS


def field_verified(field):
    return (field['availability'] == 'available_verified' and known(field.get('evidence_ref'))
            and known(field.get('parser_version')))


def missing_field_rights(field):
    return [key for key in FIELD_RIGHTS_TERMS if not known(field.get(key))]


def csv_evidence(root, name, required):
    content = (root / name).read_bytes()
    reader = csv.DictReader(io.StringIO(content.decode('utf-8-sig'), newline=''), strict=True)
    headers = reader.fieldnames or []
    if len(set(headers)) != len(headers) or not required.issubset(headers):
        raise ValueError(f'{name}: missing or duplicate headers')
    rows = list(reader)
    if any(None in row or None in row.values() for row in rows):
        raise ValueError(f'{name}: inconsistent row length')
    return rows, hashlib.sha256(content).hexdigest()


def utc_instant(value):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)', value or ''):
        return None
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None


def period_terms(row, start_key, end_key, as_of):
    start, end = (utc_instant(row.get(key)) for key in (start_key, end_key))
    issues = {}
    for key, instant in ((start_key, start), (end_key, end)):
        if known(row.get(key)) and instant is None:
            issues[key] = 'utc_timestamp_required'
    if start and end and start >= end:
        issues[end_key] = 'must_follow_effective_at'
    elif end and end <= as_of:
        issues[end_key] = 'expired'
    if start and start > as_of:
        issues[start_key] = 'not_effective_yet'
    return start, end, issues


def field_terms(field, as_of, source_start, source_end):
    start, end, issues = period_terms(field, 'rights_effective_at', 'rights_expires_at', as_of)
    if start and source_start and start < source_start:
        issues['rights_effective_at'] = 'starts_before_source'
    if end and source_end and end > source_end:
        issues['rights_expires_at'] = 'extends_past_source'
    if known(field.get('retention_days')) and not re.fullmatch(r'\d+', field['retention_days'], re.ASCII):
        issues['retention_days'] = 'nonnegative_integer_required'
    if (field.get('approval_status') or '').strip().lower() in {'denied', 'expired', 'revoked'}:
        issues['approval_status'] = 'inactive'
    return issues


def prepare_report(root=ROOT, *, as_of=None):
    as_of = datetime.now(timezone.utc) if as_of is None else as_of
    if as_of.utcoffset() != timedelta(0):
        raise ValueError('Readiness observation time must be UTC')
    sources, source_digest = csv_evidence(root, 'source-clearance.csv', {
        'candidate_id', 'marketplace', 'status', 'network_enabled', 'media_retention_days',
        'media_evidence_ref', *SOURCE_TERMS, *RIGHTS, *MEDIA_RIGHTS,
    })
    fields, field_digest = csv_evidence(root, 'source-capabilities.csv', {
        'source_candidate', 'field', 'availability', 'evidence_ref', 'parser_version', *FIELD_RIGHTS_TERMS,
    })
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
        missing += [key for key in SOURCE_TERMS if not known(source.get(key))]
        if source.get('status') != 'APPROVED':
            missing.append('source_approval')
        if source.get('network_enabled') != 'false':
            raise ValueError('Offline preparation requires network_enabled=false')
        source_start, source_end, source_terms = period_terms(source, 'effective_at', 'expires_at', as_of)
        for key in ('rate_cap', 'concurrency_cap', 'retention_days'):
            if known(source.get(key)) and not re.fullmatch(r'[1-9][0-9]*', source[key]):
                source_terms[key] = 'positive_integer_required'
        method = source.get('allowed_access_method')
        if known(method) and method not in {'approved_http', 'approved_browser', 'offline_fixture'}:
            source_terms['allowed_access_method'] = 'unsupported_method'
        elif method == 'offline_fixture' and source.get('status') == 'APPROVED':
            source_terms['allowed_access_method'] = 'offline_fixture_only'
        selected = by_source[source['candidate_id']]
        expected = EBAY_US_FIELDS if source.get('marketplace') == 'ebay_us' else None
        missing_fields = [name for name in expected or () if name not in selected]
        unverified = [name for name, field in selected.items() if not field_verified(field)]
        field_rights = {name: terms for name, field in selected.items()
                        if (terms := missing_field_rights(field))}
        field_issues = {name: terms for name, field in selected.items()
                        if (terms := field_terms(field, as_of, source_start, source_end))}
        media_missing = [right for right in MEDIA_RIGHTS if source.get(right) != 'allowed']
        if not re.fullmatch(r'[1-9][0-9]*', source.get('media_retention_days') or ''):
            media_missing.append('media_retention_days')
        if not known(source.get('media_evidence_ref')):
            media_missing.append('media_evidence_ref')
        gaps.append({'source': source['candidate_id'], 'missingRightsOrTerms': missing,
                     'sourceTermIssues': source_terms, 'fieldTermIssues': field_issues,
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
    digests = {'source-clearance.csv': source_digest, 'source-capabilities.csv': field_digest}
    return {'schema': 'soldbench.preparation-report.v1', 'mode': 'offline_fixture', 'collectorEnabled': False,
            'observedAt': as_of.isoformat(),
            'status': 'REQUIRES_EXTERNAL_REVIEW', 'stageVerdict': 'NOT_ISSUED',
            'gaps': gaps, 'sha256': digests, 'approvalEvidenceValidated': False}


if __name__ == '__main__':
    print(json.dumps(prepare_report(), indent=2))
