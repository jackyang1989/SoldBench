#!/usr/bin/env python3
"""Validate SoldBench design contracts and synthetic examples, never call services."""
import copy
import argparse
import hashlib
import json
import re
from pathlib import Path
import yaml
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / 'docs'
class UniqueKeyLoader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        seen = set()
        for key_node, _ in node.value:
            key = self.construct_object(key_node, deep=deep)
            if key in seen:
                raise ValueError(f'Duplicate OpenAPI key: {key} at line {key_node.start_mark.line + 1}')
            seen.add(key)
        return super().construct_mapping(node, deep=deep)


SPEC = yaml.load((DOCS / 'openapi.yaml').read_text(), Loader=UniqueKeyLoader)
SCHEMAS = SPEC['components']['schemas']
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--formal', action='store_true', help='Also use openapi-spec-validator==0.7.2')
args = parser.parse_args()
if args.formal:
    from openapi_spec_validator import validate_spec
    validate_spec(SPEC)
    print('PASS: OpenAPI 3.1 specification validation (openapi-spec-validator 0.7.2).')


def require(condition, message):
    if not condition:
        raise ValueError(message)


# Internal references are rooted at the complete OpenAPI document, whose schema
# vocabulary uses JSON Schema 2020-12, rather than at each component in isolation.
URI = 'urn:soldbench:openapi'
resource = Resource.from_contents({'$schema':'https://json-schema.org/draft/2020-12/schema', **SPEC})
registry = Registry().with_resource(URI, resource)

def validator(name):
    return Draft202012Validator({'$ref':URI+'#/components/schemas/'+name}, registry=registry, format_checker=FormatChecker())


def walk(value):
    if isinstance(value, dict):
        if '$ref' in value:
            ref = value['$ref']
            require(ref.startswith('#/components/schemas/'), f'Unsupported reference {ref}')
            require(ref.rsplit('/',1)[1] in SCHEMAS, f'Broken schema reference {ref}')
        for item in value.values():
            walk(item)
    elif isinstance(value, list):
        for item in value:
            walk(item)


require(SPEC['openapi']=='3.1.0','Unexpected OpenAPI version')
walk(SPEC)
# A display preference must not silently become a paid-query parameter.
require(SPEC['x-i18n-policy']['supported_ui_locales']==['en','zh-CN'], 'Missing approved bilingual baseline')
require(not ({'locale','language','display_timezone'} & set(SCHEMAS['SoldQuery']['properties'])),
        'Display preferences leaked into SoldQuery')
for path, methods in SPEC['paths'].items():
    for method, operation in methods.items():
        if method not in {'get','post','put','patch','delete'}:
            continue
        language_headers = [p for p in operation.get('parameters', [])
                            if p.get('in')=='header' and p.get('name')=='Accept-Language']
        require(len(language_headers)==(0 if path.startswith('/webhooks/') else 1),
                f'Language preference contract missing/duplicated: {method} {path}')
        require(all(not p.get('required', False) for p in language_headers), 'Language header must remain optional')
# Explicit payment selection must not activate reserve providers or silent fallback.
require(SPEC['x-payment-policy']['primary']=='stripe' and
        SPEC['x-payment-policy']['supplemental']=='paypal' and
        SPEC['x-payment-policy']['automatic_fallback'] is False, 'Payment roles drifted')
checkout_validator = validator('CheckoutRequest')
for selected in (None, 'stripe', 'paypal'):
    payload = {'plan_code':'starter', 'offer_version':'contract-test'}
    if selected is not None:
        payload['provider'] = selected
    checkout_validator.validate(payload)
for selected in ('creem','dodo','paddle','unknown'):
    payload = {'plan_code':'starter', 'offer_version':'contract-test', 'provider':selected}
    require(list(checkout_validator.iter_errors(payload)), f'Reserve provider accepted at checkout: {selected}')
for provider in ('paddle','dodo'):
    require(SPEC['paths'][f'/webhooks/{provider}']['post']['x-provider-profile']=='reserved-disabled',
            f'Reserve webhook enabled in design: {provider}')
for provider, scheme in (('stripe','StripeSignature'), ('paypal','PayPalSignature')):
    require(SPEC['paths'][f'/webhooks/{provider}']['post']['security']==[{scheme:[]}],
            f'Wrong payment signature contract: {provider}')
print('PASS: Stripe/PayPal checkout choices, four inactive/unknown choices rejected, independent webhook schemes.')
for name,schema in SCHEMAS.items():
    Draft202012Validator.check_schema(schema)
operations = {}
documented_paths = set()
for line in (DOCS/'接口与数据契约.md').read_text().splitlines():
    if line.startswith('| API-'):
        for code_span in re.findall(r'`([^`]+)`', line):
            documented_paths.update(re.findall(r'/[a-zA-Z0-9_/{\}-]+', code_span))
require(documented_paths == set(SPEC['paths']), 'API table and OpenAPI paths diverged')
for path, methods in SPEC['paths'].items():
    for method, operation in methods.items():
        require(method in ('get','post','delete','patch','put'), f'Unknown method {method}')
        opid = operation['operationId']
        require(opid not in operations, f'Duplicate operation {opid}')
        operations[opid] = (path,method)
        names = [(p['in'],p['name']) for p in operation['parameters']]
        require(len(set(names))==len(names), f'Duplicate parameters {opid}')
        path_params = {p['name'] for p in operation['parameters'] if p['in']=='path' and p['required']}
        require(path_params==set(re.findall(r'{(\w+)}',path)), f'Path parameter mismatch {opid}')
        require(operation['x-task'] and operation['x-roles'] and 'x-credit-policy' in operation, f'Unmapped operation {opid}')
        require(any(s.startswith('2') for s in operation['responses']), f'No success response {opid}')
        for scheme in operation['security']:
            require(set(scheme)<=SPEC['components']['securitySchemes'].keys(), f'Unknown security in {opid}')
        for p in operation['parameters']:
            Draft202012Validator.check_schema(p['schema'])
        if '204' in operation['responses']:
            require('content' not in operation['responses']['204'], f'204 with body: {opid}')

manifest=json.loads((DOCS/'contracts/fixtures/manifest.json').read_text())
fixtures={}
for entry in manifest:
    path=DOCS/'contracts/fixtures'/entry['file']
    value=json.loads(path.read_text())
    validator(entry['schema']).validate(value)
    fixtures[path.stem]=value

base=fixtures['sold-200-50']; inputs=fixtures['calculation-inputs-58']['data']
require(len(base['data']['comps'])==base['meta']['returned_comp_count']==50,'Not a complete limit50 fixture')
require(len(inputs['items'])==base['meta']['available_comp_count']==58,'Full recomputation collection omitted')
require(base['meta']['candidate_set_hash']==inputs['candidate_set_hash'],'Input hash mismatch')
original=json.loads((ROOT/'v14_gameboy_58_verified.json').read_text())
require(base['data']['stats']==original['expected_stats'],'Original stats drift')
verified={v['sale_event_id']:v for v in original['candidate_records'] if v['is_comparable'] and v['sale_price_status']=='verified_actual'}
require({v['sale_event_id'] for v in inputs['items']}==set(verified),'Calculation identities drift')
for comp in base['data']['comps']:
    require(comp['price_usd_cents']==verified[comp['sale_event_id']]['price_usd_cents'],'Displayed price drift')
require(fixtures['sold-200-stale']['meta']['credits_charged']==0,'Stale charged')
require(fixtures['sold-200-empty']['data']['stats']['median_cents'] is None,'Empty centre not null')
require(fixtures['job-completed-unclaimed']['data']['settlement_status']=='pending','Unclaimed job charged')
require(fixtures['sold-202']['meta']['credits_charged']==0,'Queue charged')

negative=[]
def rejected(name, schema, value):
    require(not validator(schema).is_valid(value), f'Invalid example accepted: {name}')
    negative.append(name)

bad=copy.deepcopy(base);bad['data']['stats']['median_cents']=58.01;rejected('fractional money','SoldResult',bad)
bad=copy.deepcopy(base);bad['data']['quality']['score']=99;rejected('uncalibrated score','SoldResult',bad)
bad=copy.deepcopy(base);bad['meta']['credits_charged']=2;rejected('double credits','SoldResult',bad)
bad=copy.deepcopy(base);bad['data']['comps'][0]['sale_price_status']='displayed_only';rejected('unverified comp in default list','SoldResult',bad)
bad=copy.deepcopy(base);bad['meta']['example_is_truncated']=True;rejected('doc-only field','SoldResult',bad)
rejected('limit201','SoldQuery',{'q':'test','limit':201})
rejected('unknown filter','SoldQuery',{'q':'test','attributes':{'invented':'x'}})
rejected('zero expiry','CreateShare',{'query_id':base['data']['query_id'],'expires_in':0})
rejected('unknown API scope','CreateKey',{'name':'test','scopes':['admin:all']})
bad=copy.deepcopy(base);bad['meta'].update(stale=True,credits_charged=1);rejected('stale charge','SoldResult',bad)
bad=copy.deepcopy(fixtures['sold-200-low-sample']);bad['data']['stats']['median_cents']=5800;rejected('small-sample centre','SoldResult',bad)

schema_sql=(DOCS/'contracts/schema.sql').read_text()
require('CREATE TABLE credit_recoveries' in schema_sql and 'CREATE TABLE query_result_sources' in schema_sql,'Missing recovery/rights relations')
require('PARTITION BY' not in schema_sql,'Unexpected production partitioning')
print(f'PASS: {len(SCHEMAS)} component schemas, {len(operations)} unique operations, '
      f'{len(fixtures)} complete synthetic fixtures, {len(negative)} invalid shapes rejected.')
print('PASS: 50 displayed / 58 complete calculation inputs / original 121-record stats reconcile.')
print('Scope: JSON Schema + OpenAPI structure consistency; no HTTP implementation, live source, payment, or GO certification.')
