#!/usr/bin/env python3
"""Check common compatibility regressions between two SoldBench OpenAPI revisions."""
import argparse
from pathlib import Path
import sys

import yaml


METHODS = {'get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'}
MINIMUMS = ('minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties')
MAXIMUMS = ('maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties')
REVIEW = ('pattern', 'format', 'not', 'if', 'then', 'else', 'dependentSchemas', 'unevaluatedProperties',
          'propertyNames', 'patternProperties', 'contains', 'prefixItems', 'discriminator', 'multipleOf', 'uniqueItems')


def accepted_types(schema):
    value = schema.get('type')
    if value is None:
        return None
    types = {value} if isinstance(value, str) else set(value)
    return types | {'integer'} if 'number' in types else types


class ContractComparison:
    def __init__(self, old, new):
        self.old, self.new, self.findings = old, new, set()

    def add(self, where, change):
        self.findings.add(f'{where}: {change}')

    @staticmethod
    def resolve(doc, node):
        visited = set()
        while isinstance(node, dict) and '$ref' in node:
            ref = node['$ref']
            if not ref.startswith('#/') or ref in visited:
                raise ValueError(f'Unsupported or cyclic reference: {ref}')
            visited.add(ref)
            resolved = doc
            for key in ref[2:].split('/'):
                resolved = resolved[key.replace('~1', '/').replace('~0', '~')]
            node = resolved
        return node

    def schema(self, old, new, where, request, visiting=frozenset()):
        if old != new and any(isinstance(node, dict) and '$ref' in node and
                              (set(node) - {'$ref', 'description', 'summary'}) for node in (old, new)):
            self.add(where, 'reference siblings changed; review schema composition')
        old, new = self.resolve(self.old, old), self.resolve(self.new, new)
        pair = (id(old), id(new))
        if pair in visiting:
            return
        visiting = visiting | {pair}
        if not isinstance(old, dict) or not isinstance(new, dict):
            if old != new:
                self.add(where, 'boolean or composed schema changed; review compatibility')
            return
        direction = 'request' if request else 'response'
        allowed, accepted = (accepted_types(old), accepted_types(new)) if request else (accepted_types(new), accepted_types(old))
        if accepted is not None and (allowed is None or not allowed <= accepted):
            self.add(where, f'{direction} type became incompatible')
        old_values = [old['const']] if 'const' in old else old.get('enum')
        new_values = [new['const']] if 'const' in new else new.get('enum')
        allowed, accepted = (old_values, new_values) if request else (new_values, old_values)
        if accepted is not None and (allowed is None or any(value not in accepted for value in allowed)):
            self.add(where, f'{direction} allowed values became incompatible')
        baseline, candidate = (old, new) if request else (new, old)
        for name in MINIMUMS + MAXIMUMS:
            before, after = baseline.get(name), candidate.get(name)
            if after is not None and (before is None or (after > before if name in MINIMUMS else after < before)):
                self.add(where, f'{direction} {name} became incompatible')
        old_required, new_required = set(old.get('required', [])), set(new.get('required', []))
        changed_required = new_required - old_required if request else old_required - new_required
        for name in changed_required:
            self.add(f'{where}.{name}', f'{direction} required field became incompatible')
        old_props, new_props = old.get('properties', {}), new.get('properties', {})
        for name in old_props.keys() - new_props.keys():
            self.add(f'{where}.{name}', f'{direction} field removed')
        for name in old_props.keys() & new_props.keys():
            self.schema(old_props[name], new_props[name], f'{where}.{name}', request, visiting)
        if not request and old.get('additionalProperties') is False and new_props.keys() - old_props.keys():
            self.add(where, 'fields added to a previously closed response object')
        old_extra, new_extra = old.get('additionalProperties', True), new.get('additionalProperties', True)
        if not isinstance(old_extra, dict) or not isinstance(new_extra, dict):
            if old_extra != new_extra:
                self.add(where, 'additional property rules changed; review schema composition')
        else:
            self.schema(old_extra, new_extra, f'{where}.*', request, visiting)
        if 'items' in old or 'items' in new:
            self.schema(old.get('items', True), new.get('items', True), f'{where}[]', request, visiting)
        for key in REVIEW:
            if old.get(key) != new.get(key):
                self.add(where, f'{key} changed; review schema composition')
        for key in ('allOf', 'anyOf', 'oneOf'):
            a, b = old.get(key, []), new.get(key, [])
            if len(a) != len(b):
                self.add(where, f'{key} changed; review schema composition')
            else:
                for index, (left, right) in enumerate(zip(a, b)):
                    self.schema(left, right, f'{where}.{key}[{index}]', request, visiting)

    def content(self, old, new, where, request):
        for mime in old.keys() - new.keys():
            self.add(where, f'media type removed: {mime}')
        for mime in old.keys() & new.keys():
            self.schema(old[mime].get('schema', {}), new[mime].get('schema', {}), f'{where} {mime}', request)

    def parameters(self, doc, path, operation):
        result = {}
        for item in [*path.get('parameters', []), *operation.get('parameters', [])]:
            parameter = self.resolve(doc, item)
            result[(parameter['in'], parameter['name'])] = parameter
        return result

    def operation(self, old_path, new_path, old, new, where):
        if old.get('operationId') != new.get('operationId'):
            self.add(where, 'operation ID changed')
        if old.get('security', self.old.get('security', [])) != new.get('security', self.new.get('security', [])):
            self.add(where, 'authentication or scope requirements changed')
        request = self.parameters(self.old, old_path, old)
        candidate = self.parameters(self.new, new_path, new)
        for key in request.keys() | candidate.keys():
            before, after = request.get(key), candidate.get(key)
            path = f'{where} {key[0]}:{key[1]}'
            if after is None:
                self.add(path, 'parameter removed')
            elif not before:
                if after.get('required'):
                    self.add(path, 'required parameter added')
            else:
                if after.get('required') and not before.get('required'):
                    self.add(path, 'optional parameter became required')
                if any(before.get(name) != after.get(name) for name in ('style', 'explode', 'allowReserved')):
                    self.add(path, 'parameter serialization changed')
                self.schema(before.get('schema', {}), after.get('schema', {}), path, True)
                self.content(before.get('content', {}), after.get('content', {}), path, True)
        body, new_body = [self.resolve(doc, operation.get('requestBody', {}))
                          for doc, operation in ((self.old, old), (self.new, new))]
        if new_body.get('required') and not body.get('required'):
            self.add(where, 'request body became required')
        self.content(body.get('content', {}), new_body.get('content', {}), f'{where} request', True)
        for status, response in old.get('responses', {}).items():
            if status not in new.get('responses', {}):
                self.add(where, f'response status removed: {status}')
                continue
            before, after = self.resolve(self.old, response), self.resolve(self.new, new['responses'][status])
            self.content(before.get('content', {}), after.get('content', {}), f'{where} {status}', False)
            original = {k.lower(): v for k, v in before.get('headers', {}).items()}
            current = {k.lower(): v for k, v in after.get('headers', {}).items()}
            for name in original.keys() - current.keys():
                self.add(f'{where} {status}', f'response header removed: {name}')
            for name in original.keys() & current.keys():
                left = self.resolve(self.old, original[name])
                right = self.resolve(self.new, current[name])
                if left.get('required') and not right.get('required'):
                    self.add(f'{where} {status} header:{name}', 'required response header became optional')
                self.schema(left.get('schema', {}), right.get('schema', {}), f'{where} {status} header:{name}', False)

    def compare(self):
        for key, old_item in self.old['paths'].items():
            old_item = self.resolve(self.old, old_item)
            new_item = self.resolve(self.new, self.new['paths'].get(key, {}))
            for method in METHODS & old_item.keys():
                name = f'{method.upper()} {key}'
                if method not in new_item:
                    self.add(name, 'operation removed')
                else:
                    self.operation(old_item, new_item, old_item[method], new_item[method], name)
        if self.old.get('components', {}).get('securitySchemes') != self.new.get('components', {}).get('securitySchemes'):
            self.add('components.securitySchemes', 'authentication definitions changed; review compatibility')
        return sorted(self.findings)


def load(path):
    doc = yaml.safe_load(path.read_text())
    version = doc.get('openapi') if isinstance(doc, dict) else None
    if not isinstance(version, str) or not version.startswith('3.1.') or not isinstance(doc.get('paths'), dict):
        raise ValueError(f'Expected OpenAPI 3.1 with paths: {path}')
    return doc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('baseline', type=Path)
    parser.add_argument('candidate', type=Path)
    args = parser.parse_args()
    try:
        findings = ContractComparison(load(args.baseline), load(args.candidate)).compare()
    except (OSError, ValueError, KeyError, TypeError, yaml.YAMLError) as error:
        print(error, file=sys.stderr)
        return 2
    if findings:
        print('\n'.join(findings))
        return 1
    print('PASS: no supported OpenAPI compatibility regression detected.')
    print('Scope: structural review only. Behaviour, throttling, pricing and delivery guarantees require integration evidence.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
