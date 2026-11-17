#!/usr/bin/env python3
"""Server-side SoldBench client. --claim explicitly permits at most one credit."""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib import error, parse, request

class ClientError(Exception):
    def __init__(self, code, status=0):
        self.code, self.status = code, status

class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def resource_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', value):
        raise ClientError('invalid_resource_id')
    return value

def sold_price(base, key, keyword, claim=False, transport='python'):
    base = base.rstrip('/')
    url = parse.urlsplit(base)
    if (url.username or url.password or url.query or url.fragment or url.path != '/v1'
        or (url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in ('127.0.0.1', 'localhost', '::1')))):
        raise ClientError('invalid_base_url')
    if not re.fullmatch(r'sb_k_[A-Za-z0-9_-]+', key):
        raise ClientError('invalid_api_key')
    claim_key = str(uuid.uuid4())
    opener = request.build_opener(request.ProxyHandler({}), NoRedirect())
    def send(path, claiming=False):
        headers = {'Authorization': 'Bearer '+key, 'Accept': 'application/json'}
        if claiming:
            headers['Idempotency-Key'] = claim_key
        for attempt in range(3):
            try:
                if transport == 'curl':
                    # Private response files, header secret over stdin (never argv), no -L.
                    with tempfile.TemporaryDirectory(prefix='soldbench-curl-') as directory:
                        hp, bp = Path(directory)/'headers', Path(directory)/'body'
                        proc = subprocess.run(['curl', '--disable', '--silent', '--show-error', '--max-time', '30', '--max-filesize', '2097152', '--proto', '=https,http', '--noproxy', '*', '-H', '@-', '-X', 'POST' if claiming else 'GET', '-D', str(hp), '-o', str(bp), '-w', '%{http_code}', base+path], input=''.join(k+': '+v+'\n' for k,v in headers.items()), text=True, capture_output=True, timeout=35, check=False)
                        if proc.returncode:
                            raise OSError('curl_error')
                        status = int(proc.stdout)
                        header_text = hp.read_text()
                        retry_after = next((line.split(':',1)[1].strip() for line in reversed(header_text.splitlines()) if line.lower().startswith('retry-after:')), None)
                        content = bp.read_bytes()
                else:
                    req = request.Request(base+path, headers=headers, method='POST' if claiming else 'GET', data=b'' if claiming else None)
                    try:
                        response = opener.open(req, timeout=30)
                    except error.HTTPError as exc:
                        response = exc
                    with response:
                        status, retry_after = response.code, response.headers.get('Retry-After')
                        deadline, chunks, length = time.monotonic()+30, [], 0
                        while True:
                            if time.monotonic() > deadline:
                                raise OSError('response_timeout')
                            chunk = response.read1(min(65536, 2097153-length))
                            if not chunk:
                                break
                            chunks.append(chunk)
                            length += len(chunk)
                            if length > 2097152:
                                break
                        content = b''.join(chunks)
            except (OSError, error.URLError, subprocess.TimeoutExpired):
                if attempt == 2:
                    raise ClientError('network_error') from None
                time.sleep(.25*(2**attempt))
                continue
            try:
                if len(content) > 2097152:
                    raise ValueError()
                body = json.loads(content.decode('utf-8'))
                if not isinstance(body, dict):
                    raise ValueError()
            except (ValueError, UnicodeError):
                raise ClientError('invalid_response', status) from None
            code = body.get('error', {}).get('code', 'http_error') if isinstance(body.get('error', {}), dict) else 'http_error'
            if not isinstance(code, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,79}', code):
                code = 'http_error'
            if (status == 429 or status >= 500) and code not in ('quota_exceeded', 'insufficient_credits', 'forbidden') and attempt < 2:
                try:
                    delay = (int(retry_after) if retry_after.isdigit() else parsedate_to_datetime(retry_after).timestamp()-time.time()) if retry_after else .25*(2**attempt)
                except (ValueError, TypeError, OverflowError):
                    raise ClientError('retry_later', status) from None
                if delay > 30:
                    raise ClientError('retry_later', status)
                time.sleep(max(0, delay))
                continue
            if status == 409 and code == 'result_not_claimed':
                return status, body
            if not 200 <= status < 300:
                raise ClientError(code, status)
            if not isinstance(body.get('data'), dict):
                raise ClientError('invalid_response', status)
            return status, body
        raise ClientError('retry_exhausted')
    _, searched = send('/sold?'+parse.urlencode({'q': keyword}))
    query_id, job_id = resource_id(searched['data'].get('query_id')), resource_id(searched['data'].get('job_id'))
    for _ in range(40):
        _, job = send('/jobs/'+job_id)
        if job['data'].get('status') == 'completed':
            break
        if job['data'].get('status') not in ('queued', 'running'):
            raise ClientError('job_not_completed')
        time.sleep(.25)
    else:
        raise ClientError('poll_limit_reached')
    status, result = send('/sold/'+query_id)
    if status == 409:
        if not claim:
            raise ClientError('claim_required', 409)
        _, result = send('/sold/'+query_id+'/claim', True)
    stats, meta = result['data'].get('stats', {}), result.get('meta', {})
    median, count = stats.get('median_cents'), stats.get('n_price_verified')
    if (median is not None and (type(median) is not int or median < 0)) or type(count) is not int or count < 0:
        raise ClientError('invalid_statistics')
    return {'query_id': query_id, 'median_cents': median, 'n_price_verified': count, 'data_mode': meta.get('data_mode', 'unknown'), 'credits_charged': meta.get('credits_charged')}

if __name__ == '__main__':
    try:
        if any(arg not in ('--claim', '--transport=curl') for arg in sys.argv[1:]):
            raise ClientError('invalid_argument')
        print(json.dumps(sold_price(os.environ.get('SOLDBENCH_BASE_URL', 'http://127.0.0.1:3000/v1'), os.environ.get('SOLDBENCH_API_KEY', ''), os.environ.get('SOLDBENCH_KEYWORD', 'Nintendo Switch OLED'), '--claim' in sys.argv, 'curl' if '--transport=curl' in sys.argv else 'python')))
    except ClientError as exc:
        print(json.dumps({'error': exc.code, 'status': exc.status}), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print(json.dumps({'error': 'client_error', 'status': 0}), file=sys.stderr)
        sys.exit(1)
