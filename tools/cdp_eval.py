#!/usr/bin/env python3
import json, sys, urllib.request
from pathlib import Path

# Reuse the tiny dependency-free CDP websocket implementation recovered during
# reverse engineering, but parameterize its hard-coded endpoint.
port = int(sys.argv[1])
selector = sys.argv[2]
expression = sys.argv[3] if len(sys.argv) > 3 else 'document.body.innerText'
source = (Path(__file__).with_name('cdp.py')).read_text().replace('127.0.0.1:9222', f'127.0.0.1:{port}')
ns = {'__name__': 'cdp_runtime'}
exec(compile(source.split('if __name__ == "__main__":')[0], str(Path(__file__).with_name('cdp.py')), 'exec'), ns)
targets = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json'))
matches = [t for t in targets if selector in t['url']]
if not matches:
    raise SystemExit(f'没有匹配的 CDP 页面: {selector}')
result = ns['eval_js'](matches[0]['webSocketDebuggerUrl'], expression)
print(json.dumps(result, ensure_ascii=False, indent=2))
