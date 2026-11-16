#!/usr/bin/env python3
"""Offline audit of the supplied synthetic fixture; not the production engine."""
import argparse
import hashlib
import json
from collections import Counter
from datetime import datetime, timedelta
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT = ROOT / 'v14_gameboy_58_verified.json'
EXPECTED_SHA = 'd59be9da67aa558d3cb494ec06d9918fd185afc3ec3b4daa31c0f6a7b244ae78'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def instant(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def half_up(value):
    require(value >= 0, 'This fixture uses nonnegative prices')
    return (2 * value.numerator + value.denominator) // (2 * value.denominator)


def quantile(prices, p):
    h = (len(prices) - 1) * p
    i = h.numerator // h.denominator
    j = min(i + 1, len(prices) - 1)
    return half_up(Fraction(prices[i]) + (h - i) * (prices[j] - prices[i]))


def summary(prices):
    prices = sorted(prices)
    n = len(prices)
    fields = dict.fromkeys(('median_cents', 'p25_cents', 'p75_cents', 'trimmed_mean_cents'))
    fields.update(observed_min_cents=min(prices) if n else None,
                  observed_max_cents=max(prices) if n else None)
    if n >= 8:
        k = n // 20
        kept = prices[k:n-k]
        fields.update(median_cents=quantile(prices, Fraction(1, 2)),
                      p25_cents=quantile(prices, Fraction(1, 4)),
                      p75_cents=quantile(prices, Fraction(3, 4)),
                      trimmed_mean_cents=half_up(Fraction(sum(kept), len(kept))))
    return fields


def audit(path):
    raw = path.read_bytes()
    data = json.loads(raw)
    require(data['synthetic_test_data'] is True, 'Must remain explicitly synthetic')
    require(data['fixture_version'] == 'v1.4', 'Unexpected fixture version')
    require(data['query']['price_basis'] == 'item_plus_observed_shipping', 'Unexpected price basis')
    records = data['candidate_records']
    require(len({r['sale_event_id'] for r in records}) == len(records), 'Duplicate event ID')
    as_of = instant(data['as_of'])
    start = as_of - timedelta(days=data['query']['window_days'])
    require(all(start < instant(r['sold_at']) <= as_of for r in records), 'Outside fixture window')
    comparable = [r for r in records if r['is_comparable']]
    verified = []
    for r in comparable:
        eligible = (r['sale_price_status'] == 'verified_actual'
                    and r['observed_shipping_status'] in ('observed', 'verified_free_shipping')
                    and r['observed_shipping_cents'] is not None)
        if not eligible:
            require(r['price_usd_cents'] is None, 'Ineligible total price presented as known')
            continue
        require(r.get('currency') == 'USD', 'Eligible fixture price must be USD')
        for name in ('item_price_cents', 'observed_shipping_cents', 'price_usd_cents'):
            require(type(r[name]) is int and r[name] >= 0, f'Invalid integer cents: {name}')
        require(r['item_price_cents'] + r['observed_shipping_cents'] == r['price_usd_cents'],
                'Item + observed shipping mismatch')
        if r['observed_shipping_status'] == 'verified_free_shipping':
            require(r['observed_shipping_cents'] == 0, 'Free shipping must be zero')
        verified.append(r)
    stats = {
        'n_observed': len(records), 'n_comparable': len(comparable),
        'n_price_verified': len(verified),
        'n_excluded_unverified_price': len(comparable) - len(verified),
        'sold_last_30d_observed': sum(as_of-timedelta(days=30) < instant(r['sold_at']) <= as_of
                                    for r in verified),
        **summary([r['price_usd_cents'] for r in verified]),
        'buy_it_now_verified_count': sum(r['sale_format'] == 'fixed_price' for r in verified),
        'best_offer_verified_count': sum(r['sale_format'] == 'best_offer' for r in verified),
        'best_offer_displayed_only_count': sum(r['sale_format'] == 'best_offer'
                                             and r['sale_price_status'] == 'displayed_only'
                                             for r in comparable),
    }
    require(stats == data['expected_stats'], f'Statistics mismatch: {stats}')
    n = len(verified)
    quality = {
        'data_insufficient': n < 8,
        'quality_status': 'sufficient_sample' if n >= 30 else 'limited_sample' if n >= 8 else 'insufficient_sample',
        'verified_share': float(Fraction(n, len(comparable))) if comparable else None,
        'coverage_status': 'unknown', 'coverage_ratio': None, 'score': None,
    }
    require(quality == data['expected_quality'], 'Quality fixture mismatch')
    digest = hashlib.sha256(raw).hexdigest()
    if path.resolve() == DEFAULT.resolve():
        require(digest == EXPECTED_SHA, 'Original fixture changed; inspect and version explicitly')
    return {'result': 'PASS', 'mode': 'offline_synthetic_fixture_only', 'sha256': digest,
            'stats': stats, 'quality': quality,
            'records_missing_production_listing_id': sum('listing_id' not in r for r in records),
            'primary_fixture_exclusions': dict(Counter(x for r in records for x in r.get('exclusion_reasons', []))),
            'does_not_verify': ['source_rights', 'live_collector', 'matching_precision', 'billing', 'production_engine', 'GO']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', type=Path, default=DEFAULT)
    args = parser.parse_args()
    # Verify the audit oracle's arithmetic, without claiming a full production test suite.
    require(half_up(Fraction(3, 2)) == 2, 'Half-up failed')
    require(summary([])['observed_min_cents'] is None, 'Empty range failed')
    require(summary([0] * 7)['median_cents'] is None, 'Low sample guard failed')
    require(summary([0] * 8)['median_cents'] == 0, 'Zero price is not missing')
    print(json.dumps(audit(args.fixture), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
