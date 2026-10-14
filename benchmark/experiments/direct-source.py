"""Read pinned public repository archives as data; never extract or execute them."""
import concurrent.futures
import hashlib
import json
import pathlib
import re
import sys
import tarfile
import threading
import urllib.request
from importlib.util import spec_from_file_location, module_from_spec

spec = spec_from_file_location('symbols', pathlib.Path(__file__).with_name('python-symbols.py'))
module = module_from_spec(spec)
spec.loader.exec_module(module)
archive_locks = {}


def eligible(member):
    parts = pathlib.PurePosixPath(member.name).parts
    if not member.isfile() or len(parts) < 2 or member.name.startswith('/'):
        return None
    parts = parts[1:]
    if any(p in ('..', 'dist', 'node_modules') or p.startswith('.') or
           re.search(r'^(credentials|secrets?)(\.|$)|\.(pem|key|p12|pfx)$', p, re.I) for p in parts):
        return None
    return '/'.join(parts)


def prepare_one(task, root):
    with archive_locks.setdefault(task['base_commit'], threading.Lock()):
        return prepare_locked(task, root)


def prepare_locked(task, root):
    commit, repo = task['base_commit'], task['repo']
    if not re.fullmatch(r'[a-f0-9]{40}', commit) or not re.fullmatch(r'[\w.-]+/[\w.-]+', repo):
        raise ValueError('Invalid pinned source')
    target = root / 'archives' / (commit + '.tar.gz')
    inventory = root / 'inventories' / (task['instance_id'] + '.json')
    if inventory.exists():
        cached = json.loads(inventory.read_text())
        if target.exists():
            with target.open('rb') as stream:
                if cached['archiveSha256'] == hashlib.file_digest(stream, 'sha256').hexdigest():
                    return cached
    if not target.exists():
        temporary = target.with_suffix('.partial')
        try:
            request = urllib.request.Request(f'https://codeload.github.com/{repo}/tar.gz/{commit}', headers={'User-Agent': 'locbench-direct-ranking'})
            with urllib.request.urlopen(request, timeout=180) as response, temporary.open('wb') as output:
                size = 0
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > 512 * 1024 * 1024:
                        raise ValueError('Archive exceeds 512 MiB cap')
                    output.write(chunk)
            temporary.rename(target)
        finally:
            temporary.unlink(missing_ok=True)
    names = []
    with tarfile.open(target, 'r|gz') as archive:
        for member in archive:
            name = eligible(member)
            if name:
                names.append(name)
    with target.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    result = {'instance_id': task['instance_id'], 'commit': commit, 'repo': repo,
              'archiveSha256': digest,
              'names': sorted(set(names))}
    inventory.write_text(json.dumps(result))
    print(f'PREPARED {task["taskNumber"]} {task["instance_id"]} files={len(names)}', flush=True)
    return result


def bodies(archive_path, selected):
    symbols, errors = [], []
    with tarfile.open(archive_path, 'r|gz') as archive:
        for member in archive:
            name = eligible(member)
            if name not in selected or not name.endswith('.py'):
                continue
            if member.size > 2_000_000:
                errors.append({'path': name, 'error': 'Source exceeds 2 MB'}); continue
            try:
                text = archive.extractfile(member).read().decode('utf-8')
                symbols.extend(module.extract(name, text))
            except (UnicodeError, SyntaxError, ValueError, RecursionError) as error:
                errors.append({'path': name, 'error': type(error).__name__})
    return {'symbols': symbols, 'errors': errors}


if __name__ == '__main__':
    if sys.argv[1] == 'bodies':
        print(json.dumps(bodies(sys.argv[2], set(json.load(sys.stdin)))))
    elif sys.argv[1] == 'prepare':
        root = pathlib.Path(sys.argv[2])
        (root / 'archives').mkdir(exist_ok=True)
        (root / 'inventories').mkdir(exist_ok=True)
        tasks = json.loads((root / 'tasks.json').read_text())
        errors = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(prepare_one, task, root): task for task in tasks}
            for future in concurrent.futures.as_completed(futures):
                try:
                    future.result()
                except Exception as error:
                    task = futures[future]
                    errors.append({'instance_id': task['instance_id'], 'error': str(error)})
                    print(f'PREPARE_ERROR {task["instance_id"]}: {error}', flush=True)
        (root / 'preparation-errors.json').write_text(json.dumps(errors, indent=2))
        print(f'PREPARATION_DONE tasks={len(tasks)} errors={len(errors)}', flush=True)
