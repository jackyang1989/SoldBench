#!/usr/bin/env python3
"""Build only owned public developer assets; no network, source records or secrets."""
import hashlib
import json
import re
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[1]
assets, pages = {}, []
def add(path, body, content_type):
    if path in assets:
        raise ValueError('duplicate_asset_path')
    assets[path] = {'body': body, 'contentType': content_type, 'etag': '"'+hashlib.sha256(body.encode()).hexdigest()+'"'}
def json_asset(path, value):
    add(path, json.dumps(value, ensure_ascii=False, indent=2)+'\n', 'application/json; charset=utf-8')

spec = yaml.safe_load((ROOT/'docs/openapi.yaml').read_text())
json_asset('/openapi.json', spec)
for locale in ('en', 'zh-CN'):
    for file in sorted((ROOT/'developer/content'/locale).glob('*.md')):
        body = file.read_text()
        path = '/docs/'+locale+'/'+file.stem
        pages.append({'path': path, 'locale': locale, 'title': body.splitlines()[0].removeprefix('# '), 'text': body})
        add(path, body, 'text/markdown; charset=utf-8')
for file in sorted((ROOT/'developer/skills/soldbench').rglob('*')):
    if file.is_file():
        rel = file.relative_to(ROOT/'developer/skills/soldbench').as_posix()
        add('/.well-known/skills/soldbench/'+rel, file.read_text(), 'text/markdown; charset=utf-8' if rel.endswith('.md') else 'text/yaml; charset=utf-8')
json_asset('/.well-known/skills/index.json', {'version': 1, 'skills': [{'name': 'soldbench', 'description': 'Server-side sold-price research REST and MCP integration; current build uses synthetic fixtures.', 'url': '/.well-known/skills/soldbench/SKILL.md'}]})
for file in sorted((ROOT/'developer/examples').glob('sold.*')):
    add('/examples/'+file.name, file.read_text(), 'text/plain; charset=utf-8')
add('/changelog', (ROOT/'developer/changelog.md').read_text(), 'text/markdown; charset=utf-8')
index = '# SoldBench developer resources\n\nLocal offline synthetic engineering; deployment targets are not live service claims.\n\n'
index += '\n'.join('- ['+p['title']+']('+p['path']+')' for p in pages)
index += '\n\n- [OpenAPI](/openapi.json)\n- [Skill](/.well-known/skills/soldbench/SKILL.md)\n- [Collection](/soldbench.postman.json)\n- [Changelog](/changelog)\n'
add('/llms.txt', index, 'text/plain; charset=utf-8')
add('/llms-full.txt', index+'\n\n'+'\n\n'.join(p['text'] for p in pages)+'\n\n'+(ROOT/'developer/skills/soldbench/references/api-reference.md').read_text(), 'text/plain; charset=utf-8')
items=[]
for name, method, path in [('Submit search','GET','/sold?q=Nintendo%20Switch%20OLED'),('Job status','GET','/jobs/{{job_id}}'),('Read result (free)','GET','/sold/{{query_id}}'),('Explicit claim (up to 1 credit)','POST','/sold/{{query_id}}/claim'),('Full diagnostics','GET','/sold/{{query_id}}/diagnostics'),('Owner request audit','GET','/requests')]:
    headers=[{'key':'Accept','value':'application/json'}]
    if method == 'POST':
        headers.append({'key':'Idempotency-Key','value':'{{claim_key}}'})
    items.append({'name':name,'request':{'method':method,'header':headers,'url':'{{base_url}}'+path,'description':'Local synthetic build. Set query_id/job_id from responses. Explicit claim needs consent; keep claim_key stable on retries.'}})
json_asset('/soldbench.postman.json', {'info':{'name':'SoldBench offline research','schema':'https://schema.getpostman.com/json/collection/v2.1.0/collection.json','description':'No automatic claims or scripts; API key empty. Production integration remains gated.'},'auth':{'type':'bearer','bearer':[{'key':'token','value':'{{api_key}}','type':'string'}]},'variable':[{'key':k,'value':v} for k,v in [('base_url','http://127.0.0.1:3000/v1'),('api_key',''),('query_id',''),('job_id',''),('claim_key','set-one-stable-key-before-claiming')]],'item':items})
# Contract-only operations remain visible as such, never inferred as accepted features.
source='\n'.join(p.read_text() for p in (ROOT/'apps/api/src').glob('*.ts'))
registered={(m.upper(), re.sub(r':([a-z_]+)', '{}', path)) for m,path in re.findall(r'app\.(get|post|delete|patch|put)\("([^"\n]+)"', source)}
operations=[]
for path,methods in spec['paths'].items():
    for method,op in methods.items():
        route=re.sub(r'\{[^}]+\}', '{}',path)
        present=(method.upper(),route) in registered or path == '/mcp'
        operations.append({'operation_id':op['operationId'],'method':method.upper(),'path':path,'status':'local_route_present' if present else 'contract_only'})
json_asset('/docs/implementation-status.json', {'schema_version':spec['info']['version'],'data_mode':'synthetic_fixture','acceptance':'Local route presence is not functional, production or stage acceptance.','operations':operations})
output=ROOT/'apps/api/dist/developer/assets.json'
output.parent.mkdir(parents=True,exist_ok=True)
output.write_text(json.dumps({'assets':assets,'pages':pages},ensure_ascii=False))
print(json.dumps({'developer_assets':len(assets),'localized_pages':len(pages),'openapi_version':spec['info']['version']}))
