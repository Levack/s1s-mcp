"""Offline Docker command-startup probe; no model calls or image pulls."""
import json
import pathlib
import subprocess
import time
import uuid

root = pathlib.Path('benchmark/results/delivery-experiments-2026-10-09')
image = json.loads((root / 'swe-prefetch-lean/tasks.json').read_text())[0]['imageId']
name = 's1s-overhead-audit-' + uuid.uuid4().hex


def docker(*args):
    return subprocess.run(['docker', *args], check=True, capture_output=True, text=True, timeout=60).stdout


rows = []
try:
    docker('run', '-d', '--pull=never', '--name', name, '--network', 'none', '--cap-drop', 'ALL',
           '--security-opt', 'no-new-privileges', '--entrypoint', '/bin/bash', image, '-c', 'sleep infinity')
    for repetition in range(10):
        variants = [('plain_bash', 'cd /testbed && true'),
                    ('activate_conda_each_call', 'source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed && cd /testbed && true')]
        for label, command in variants[::1 if repetition % 2 == 0 else -1]:
            started = time.perf_counter()
            docker('exec', name, 'bash', '-c', command)
            rows.append(dict(repetition=repetition, variant=label, milliseconds=(time.perf_counter()-started)*1000))
finally:
    docker('rm', '-f', name)
result = dict(design='Ten alternated repetitions, one existing pinned task image, isolated network-disabled container. Plain bash is a diagnostic lower bound, not a replacement with equivalent Python environment.', rows=rows)
(root / 'non-llm-audit/shell-measurements.json').write_text(json.dumps(result, indent=2))
for label in ['plain_bash', 'activate_conda_each_call']:
    values = [row['milliseconds'] for row in rows if row['variant'] == label]
    print(label, sum(values)/len(values), 'ms')
