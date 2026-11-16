#!/usr/bin/env python3
"""Read declared PoC dependencies and literal source imports for human review."""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
POC = ROOT / 'step0/collector-poc'


def inventory():
    package = json.loads((POC / 'package.json').read_text())
    lock = json.loads((POC / 'package-lock.json').read_text())
    imports = []
    source_hashes = {}
    for path in sorted((POC / 'src').glob('*.ts')):
        text = path.read_text()
        relative = str(path.relative_to(ROOT))
        source_hashes[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        for number, line in enumerate(text.splitlines(), 1):
            if line.startswith('import '):
                match = re.search(r'(?:from\s+)?[\'\"]([^\'\"]+)[\'\"]', line)
                imports.append({'file': relative, 'line': number, 'specifier': match[1] if match else None})
    packages = [{'path': name, 'version': value.get('version'), 'dev': value.get('dev', False),
                 'optional': value.get('optional', False), 'integrity': value.get('integrity')}
                for name, value in sorted(lock['packages'].items()) if name]
    return {'schema': 'soldbench.dependency-inventory.v1', 'mode': 'offline_fixture',
            'declaredRuntimeDependencies': package.get('dependencies', {}),
            'declaredDevelopmentDependencies': package.get('devDependencies', {}),
            'lockfilePackages': packages, 'literalImports': imports, 'sourceSha256': source_hashes,
            'lockfileSha256': hashlib.sha256((POC / 'package-lock.json').read_bytes()).hexdigest(),
            'scope': 'declared_dependencies_and_single_line_literal_imports',
            'dynamicBehaviorAudited': False, 'hostEgressAudited': False,
            'independentReview': 'PENDING', 'productionPackageAvailable': False}


if __name__ == '__main__':
    print(json.dumps(inventory(), indent=2))
