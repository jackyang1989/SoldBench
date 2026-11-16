#!/usr/bin/env python3
"""Check documentation links, task DAG/windows, ID coverage and original fixture."""
from pathlib import Path
import hashlib
import csv
import re

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs'


def require(ok, message):
    if not ok:
        raise ValueError(message)


def text(name):
    return (DOCS / name).read_text()


def defined_ids(pattern, source):
    values = re.findall(pattern, source, re.M)
    require(len(values) == len(set(values)), f'Duplicate definition: {pattern}')
    return set(values)


board = text('开发排期与任务台账.md')
tasks = {}
total = 0
mapped_stories = set()
for line in board.splitlines():
    if not line.startswith('| TASK-'):
        continue
    cells = [x.strip() for x in line.strip('|').split('|')]
    match = re.fullmatch(r'(TASK-\d{3}) / E(\d+)–E(\d+)', cells[0])
    require(match is not None, f'Bad task row: {line}')
    task, start, end = match[1], int(match[2]), int(match[3])
    require(task not in tasks, f'Duplicate {task}')
    require(start == total + 1 and end >= start, f'Gap/overlap at {task}')
    require(end - start + 1 == int(cells[4]), f'Effort mismatch at {task}')
    deps = re.findall(r'TASK-\d{3}', cells[3])
    require(all(d in tasks and tasks[d]['end'] < start for d in deps), f'Invalid dependency for {task}')
    require(cells[6] and cells[7] and cells[8], f'Missing owner/status/evidence for {task}')
    tasks[task] = {'end': end, 'ats': re.findall(r'AT-\d{3}', cells[5])}
    mapped_stories.update(re.findall(r'(?<![A-Za-z0-9])S-\d{2}(?!\d)', cells[1]))
    total = end

ats = defined_ids(r'^\| (AT-\d{3}) \|', text('验收矩阵.md'))
pages = defined_ids(r'^\| (PAGE-[WCA]\d{2}) \|', text('功能与页面规格.md'))
features = defined_ids(r'^\| (F-\d{2}) \|', text('功能与页面规格.md'))
decisions = defined_ids(r'^\| (DEC-\d{2}) \|', text('决策登记.md'))
apis = defined_ids(r'^\| (API-\d{2}) \|', text('接口与数据契约.md'))
require(mapped_stories == {f'S-{i:02}' for i in range(1, 28)}, 'Original S story omitted or invented in task mappings')
require(len(tasks) == 56 and total == 319, 'Unexpected task count or estimate')
require(len(features) == 16, 'Missing original F feature')
require(all(t['ats'] and set(t['ats']) <= ats for t in tasks.values()), 'Missing/undefined task tests')
require(set().union(*(set(t['ats']) for t in tasks.values())) == ats, 'Unscheduled acceptance case')
for label, name in [('page','功能与页面规格.md'), ('test','验收矩阵.md'), ('api','接口与数据契约.md')]:
    for line in text(name).splitlines():
        if re.match(r'^\| (PAGE-|AT-|API-)', line):
            refs = set(re.findall(r'TASK-\d{3}', line))
            require(refs and refs <= tasks.keys(), f'Unscheduled {label}: {line}')

files = [ROOT / 'README.md', ROOT / 'AGENTS.md', ROOT / 'agent.md', ROOT / 'SoldBench 开发规格书 v1.4.md', *DOCS.rglob('*.md'), * (ROOT / 'step0').rglob('*.md')]
# Installed dependencies and generated run output are outside authored project docs.
files = [file for file in files if not {'node_modules', 'artifacts', '.git'}.intersection(file.relative_to(ROOT).parts)]
known = {'TASK': set(tasks), 'AT': ats, 'PAGE': pages, 'DEC': decisions, 'API': apis}
patterns = {'TASK': r'(?<![A-Za-z0-9])TASK-\d{3}(?!\d)', 'AT': r'(?<![A-Za-z0-9])AT-\d{3}(?!\d)', 'PAGE': r'(?<![A-Za-z0-9])PAGE-[WCA]\d{2}(?!\d)', 'DEC': r'(?<![A-Za-z0-9])DEC-\d{2}(?!\d)', 'API': r'(?<![A-Za-z0-9])API-\d{2}(?!\d)'}
links = 0
for file in files:
    value = file.read_text()
    for prefix, pattern in patterns.items():
        require(set(re.findall(pattern, value)) <= known[prefix], f'Undefined {prefix} in {file}')
    for link in re.findall(r'\]\(([^)]+)\)', value):
        target = link.strip().strip('<>')
        if target.startswith(('https://', 'http://', '#')):
            continue
        target = target.split('#')[0]
        require((file.parent / target).exists(), f'Broken link in {file}: {target}')
        links += 1
require((ROOT/'SoldBench 开发规格书 v1.4.md').exists(), 'Original specification missing')
require((ROOT/'v14_gameboy_58_verified.json').exists(), 'Original fixture missing')
require(hashlib.sha256((DOCS/'baselines/SoldBench-v1.4-original.md').read_bytes()).hexdigest() ==
        '3fc154649f5f34031367f59f1e16f8b248d5eab89e2b6b1817d8db2892f1a7da',
        'Archived original specification changed')
roadmap = text('竞品能力实施规格与路线图.md')
capability_rows = [line for line in roadmap.splitlines() if line.startswith('| CP-')]
require({re.match(r'\| (CP-\d{2})', line)[1] for line in capability_rows} == {f'CP-{i:02}' for i in range(1, 25)}, 'Expected all 24 competitive capability groups')
for line in capability_rows:
    refs = set(re.findall(r'TASK-\d{3}', line))
    tests = set(re.findall(r'AT-\d{3}', line))
    require(refs and refs <= tasks.keys() and tests and tests <= ats, f'Unscheduled competitive gap: {line}')
with (ROOT / 'step0/source-capabilities.csv').open(newline='') as handle:
    capability_fields = {row['field'] for row in csv.DictReader(handle)}
require({'title', 'listing_url', 'primary_image_candidate', 'primary_image_role', 'primary_image_evidence_binding', 'seller_source_identity', 'seller_public_handle', 'condition_id', 'condition_mapping_context', 'shipping_context', 'source_reported_match_count', 'source_reported_match_count_context', 'source_record_unit', 'query_capture_context'} <= capability_fields, 'Search capture checklist missing required fields')
print('PASS: 24 competitive capability groups have scheduled TASK and AT references.')
print(f'PASS: {len(files)} Markdown files, {links} local links, {len(tasks)} tasks, E1–E{total}, '
      f'{len(features)} features, {len(pages)} pages, {len(ats)} acceptance cases, '
      f'{len(apis)} API groups, {len(decisions)} decisions; original S-01…S-27 mapped.')
print('Scope: documentation consistency only; no product, live-data or GO certification.')
