#!/usr/bin/env python3
"""Exact offline cost scenarios. Inputs never authorize prices or payments."""
import argparse
import json
import re
from fractions import Fraction
from pathlib import Path

FIXED = ('infra_cash_cents', 'access_license_cash_cents')
VARIABLE = ('network_cash_cents', 'compute_cash_cents', 'storage_cash_cents', 'other_cash_cents')
LABOR = ('maintenance_labor_cents', 'support_labor_cents')
COSTS = FIXED + VARIABLE + LABOR
INPUTS = ('customers', 'billable_queries', 'gross_price_cents', 'payment_transactions', 'payment_rate',
          'payment_fixed_cents', 'refund_rate', 'tax_leakage_rate', 'dispute_cost_cents', 'target_margin')


def decimal(value, name):
    if not isinstance(value, str) or not re.fullmatch(r'\d+(?:\.\d+)?', value):
        raise ValueError(name + ' requires a nonnegative exact decimal string')
    return Fraction(value)


def count(value, name):
    if type(value) is not int or value < 0:
        raise ValueError(name + ' requires a nonnegative integer')
    return value


def rounded(value):
    sign = -1 if value < 0 else 1
    value = abs(value)
    return sign * ((2 * value.numerator + value.denominator) // (2 * value.denominator))


def exact(value, money=False):
    if value is None:
        return None
    result = {'numerator': str(value.numerator), 'denominator': str(value.denominator)}
    if money:
        result['rounded_cents'] = rounded(value)
    return result


def calculate(data):
    if data.get('schema') != 'soldbench.unit-economics.v1':
        raise ValueError('Unsupported cost input schema')
    kind = data.get('evidence_kind')
    if kind not in ('unmeasured', 'assumed', 'measured'):
        raise ValueError('Unknown evidence kind')
    if kind == 'measured' and not (isinstance(data.get('evidence_ref'), str) and data['evidence_ref'].strip()):
        raise ValueError('Measured inputs require a controlled evidence reference')
    costs = data.get('costs')
    if not isinstance(costs, dict) or set(costs) - set(COSTS):
        raise ValueError('Invalid cost categories')
    missing = [key for key in INPUTS if data.get(key) is None]
    missing += ['costs.' + key for key in COSTS if costs.get(key) is None]
    report = {'schema': 'soldbench.unit-economics-report.v1', 'scenario': data.get('scenario'),
              'evidence_kind': kind, 'evidence_ref': data.get('evidence_ref'), 'missing': missing,
              'priceApproved': False, 'stabilityVerified': False, 'stageVerdict': 'NOT_ISSUED'}
    # A partial real-cost template keeps unknown values unknown.
    if missing:
        return dict(report, status='INCOMPLETE', metrics=None)
    if kind == 'unmeasured':
        raise ValueError('Filled inputs must be explicitly assumed or measured')
    customers = count(data['customers'], 'customers')
    queries = count(data['billable_queries'], 'billable_queries')
    transactions = count(data['payment_transactions'], 'payment_transactions')
    if customers == 0 and (queries or transactions):
        raise ValueError('Paid queries or transactions require paying customers')
    price = decimal(data['gross_price_cents'], 'gross_price_cents')
    if price.denominator != 1:
        raise ValueError('Gross price must be integer cents')
    rate, refund, tax, target = [decimal(data[key], key) for key in
                                ('payment_rate', 'refund_rate', 'tax_leakage_rate', 'target_margin')]
    if rate + refund + tax >= 1 or target >= 1:
        raise ValueError('Rates must leave positive proceeds and target margin must be below one')
    fee = decimal(data['payment_fixed_cents'], 'payment_fixed_cents') * transactions
    disputes = decimal(data['dispute_cost_cents'], 'dispute_cost_cents')
    values = {key: decimal(costs[key], key) for key in COSTS}
    fixed, variable, labor = [sum((values[key] for key in keys), Fraction()) for keys in (FIXED, VARIABLE, LABOR)]
    gross = price * customers
    proceeds = gross * (1 - rate - refund - tax) - fee - disputes
    cash_cost = fixed + variable
    full_cost = cash_cost + labor
    contribution = proceeds - variable
    profit = proceeds - full_cost
    required_price = None
    break_even_customers = None
    if customers:
        required_price = (full_cost / (1 - target) + fee + disputes) / ((1 - rate - refund - tax) * customers)
        required_price = -(-required_price.numerator // required_price.denominator)
        # Holds current per-customer usage mix, payment frequency and free/failure allocation fixed.
        unit_cash_contribution = (proceeds - variable) / customers
        if unit_cash_contribution > 0:
            needed = fixed / unit_cash_contribution
            break_even_customers = -(-needed.numerator // needed.denominator)
    return dict(report, status='CALCULATED', metrics={
        'gross_revenue': exact(gross, True), 'net_proceeds': exact(proceeds, True),
        'fixed_cash_cost': exact(fixed, True), 'variable_cash_cost': exact(variable, True),
        'labor_cost': exact(labor, True), 'full_cost': exact(full_cost, True),
        'full_cost_per_billable_query': exact(full_cost / queries if queries else None, True),
        'cash_contribution_margin': exact(contribution / proceeds if proceeds > 0 else None),
        'fully_loaded_margin': exact(profit / proceeds if proceeds > 0 else None),
        'economic_profit': exact(profit, True), 'cash_profit': exact(proceeds - cash_cost, True),
        'minimum_price_cents_for_target_margin': required_price,
        'cash_break_even_customers_at_current_mix': break_even_customers,
    })


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    args = parser.parse_args()
    value = json.loads(args.input.read_text())
    print(json.dumps([calculate(item) for item in value] if isinstance(value, list) else calculate(value), indent=2))
