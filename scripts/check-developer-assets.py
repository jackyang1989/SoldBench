#!/usr/bin/env python3
"""Validate owned developer assets against their frozen contract; no host skill dependency."""
import json
import re
from pathlib import Path
import yaml
ROOT=Path(__file__).resolve().parents[1]
skill=ROOT/'developer/skills/soldbench/SKILL.md'
text=skill.read_text()
front=yaml.safe_load(text.split('---',2)[1])
assert front['name']=='soldbench' and len(front['description'])>30
assert not re.search(r'\[TODO|TODO:',text)
for target in re.findall(r'\]\((references/[^)]+)\)',text):
    assert (skill.parent/target).is_file(),target
registry=json.loads((ROOT/'apps/api/dist/developer/assets.json').read_text())
assets=registry['assets']
for p in registry['pages']:
    other='zh-CN' if p['locale']=='en' else 'en'
    assert p['path'].replace('/'+p['locale']+'/', '/'+other+'/') in assets
    for link in re.findall(r'\]\((/[^)]+)\)',p['text']):
        assert link in assets,link
spec=yaml.safe_load((ROOT/'docs/openapi.yaml').read_text())
assert json.loads(assets['/openapi.json']['body'])==spec
assert json.loads(assets['/soldbench.postman.json']['body'])['variable'][1]['value']==''
for entry in json.loads(assets['/.well-known/skills/index.json']['body'])['skills']:
    assert entry['url'] in assets
assert all('..' not in path and path.startswith('/') for path in assets)
print('PASS: bilingual links, Skill metadata/references, discovery, OpenAPI JSON and credential-free collection.')
