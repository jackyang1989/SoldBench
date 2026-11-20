import copy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

from check_compatibility import ContractComparison


def contract():
    return {
        'openapi': '3.1.0',
        'paths': {
            '/v1/sold': {'get': {
                'operationId': 'find',
                'security': [{'apiKey': ['sold:read']}],
                'parameters': [{'name': 'limit', 'in': 'query', 'schema': {'type': 'integer', 'maximum': 200}}],
                'responses': {
                    '200': {'headers': {'Retry-After': {'schema': {'type': 'integer'}}},
                            'content': {'application/json': {'schema': {'$ref': '#/components/schemas/Query'}}}},
                    '503': {'description': 'Unavailable'},
                },
            }},
            '/v1/claim': {'post': {
                'requestBody': {'content': {'application/json': {'schema': {
                    'type': 'object', 'properties': {'id': {'type': 'string'}}, 'required': [],
                }}}},
                'responses': {'200': {'description': 'Claimed'}},
            }},
        },
        'components': {'schemas': {'Query': {
            'type': 'object', 'required': ['status'], 'properties': {'status': {'enum': ['queued', 'ready']}},
        }}},
    }


class CompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.old = contract()
        self.new = copy.deepcopy(self.old)

    def findings(self):
        return ContractComparison(self.old, self.new).compare()

    def test_add_optional_query_without_breaking_old_callers(self):
        self.new['paths']['/v1/sold']['get']['parameters'].append({
            'name': 'sort', 'in': 'query', 'schema': {'type': 'string'},
        })
        self.new['paths']['/v1/sold']['get']['description'] = 'Clarify what counts as a comparable sale.'
        self.new['paths']['/v1/sold']['get']['parameters'][0]['schema']['maximum'] = 250
        self.assertEqual(self.findings(), [])

    def test_required_and_narrower_request_and_changed_scope(self):
        get = self.new['paths']['/v1/sold']['get']
        get['parameters'][0]['schema']['maximum'] = 199
        get['parameters'][0]['required'] = True
        get['security'] = [{'apiKey': ['sold:write']}]
        body = self.new['paths']['/v1/claim']['post']['requestBody']
        body['required'] = True
        body['content']['application/json']['schema']['required'] = ['id']
        output = '\n'.join(self.findings())
        for fragment in ('maximum became incompatible', 'optional parameter became required',
                         'scope requirements changed', 'request body became required', 'id: request required'):
            self.assertIn(fragment, output)

    def test_ref_status_and_header_changes_reach_operations(self):
        self.new['components']['schemas']['Query']['properties']['status']['enum'].append('unknown')
        responses = self.new['paths']['/v1/sold']['get']['responses']
        responses['200']['headers'].pop('Retry-After')
        responses.pop('503')
        output = '\n'.join(self.findings())
        self.assertIn('GET /v1/sold 200 application/json.status: response allowed values', output)
        self.assertIn('response header removed: retry-after', output)
        self.assertIn('response status removed: 503', output)

    def test_recursive_ref_does_not_loop_and_flags_field_loss(self):
        for doc in (self.old, self.new):
            props = doc['components']['schemas']['Query']['properties']
            props['previous'] = {'$ref': '#/components/schemas/Query'}
        target = self.new['components']['schemas']['Query']
        target['required'] = []
        del target['properties']['status']
        output = '\n'.join(self.findings())
        self.assertIn('status: response field removed', output)
        self.assertIn('status: response required field became incompatible', output)

    def test_real_cli_rejects_operation_loss_without_network(self):
        del self.new['paths']['/v1/claim']
        with tempfile.TemporaryDirectory() as directory:
            old, new = (Path(directory) / (key + '.yaml') for key in ('old', 'new'))
            for path, payload in ((old, self.old), (new, self.new)):
                path.write_text(yaml.safe_dump(payload))
            script = Path(__file__).with_name('check_compatibility.py')
            result = subprocess.run([sys.executable, str(script), str(old), str(new)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn('POST /v1/claim: operation removed', result.stdout)


if __name__ == '__main__':
    unittest.main()
