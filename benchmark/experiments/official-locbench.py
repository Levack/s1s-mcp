"""Infrastructure adapter: unmodified upstream LocAgent search and Loc-Bench grading."""
import os
import sys
import json
import pathlib
import contextlib
import hashlib
import pickle
import tarfile
import tempfile
import shutil
import time


def setup(root):
    root = pathlib.Path(root).resolve()
    sys.path.insert(0, str(root / 'official-source'))
    os.environ['GRAPH_INDEX_DIR'] = str(root / 'graph')
    os.environ['BM25_INDEX_DIR'] = str(root / 'bm25')
    os.environ['MPLCONFIGDIR'] = '/tmp/s1s-official-mpl'
    os.environ['TOKENIZERS_PARALLELISM'] = 'false'
    return root


def prepare(root, number):
    root = setup(root)
    tasks = json.loads((root / 'tasks.json').read_text())
    task = tasks[number - 1]
    marker = root / 'preparation' / (task['instance_id'] + '.json')
    if marker.exists():
        print('PREPARED_CACHED', number, flush=True)
        return
    from dependency_graph.build_graph import build_graph
    from plugins.location_tools.retriever.bm25_retriever import build_code_retriever_from_repo
    source = root.parents[1] / 'direct-model-ranking/first100-2026-10-14'
    archive = source / 'archives' / (task['base_commit'] + '.tar.gz')
    inventory = json.loads((source / 'inventories' / (task['instance_id'] + '.json')).read_text())
    with archive.open('rb') as f:
        assert hashlib.file_digest(f, 'sha256').hexdigest() == inventory['archiveSha256']
    began = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='locbench-repo-') as temporary:
        repo = pathlib.Path(temporary)
        # Materialize only regular archive members; never follow links or run repository code.
        with tarfile.open(archive, 'r|gz') as tar:
            for member in tar:
                parts = pathlib.PurePosixPath(member.name).parts
                if not member.isfile() or len(parts) < 2 or member.name.startswith('/'):
                    continue
                parts = parts[1:]
                if any(p in ('..', '.git') for p in parts):
                    raise ValueError('Unsafe archive path')
                target = repo.joinpath(*parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(member) as src, target.open('wb') as dst:
                    shutil.copyfileobj(src, dst)
        with contextlib.redirect_stdout(sys.stderr):
            graph = build_graph(str(repo), global_import=True)
            dest = root / 'graph' / (task['instance_id'] + '.pkl')
            with dest.open('wb') as f:
                pickle.dump(graph, f)
            build_code_retriever_from_repo(str(repo), persist_path=str(root / 'bm25' / task['instance_id']))
        # Independent Jev input: upstream graph nodes, no Luna predictions or gold labels.
        from dependency_graph import RepoEntitySearcher
        from dependency_graph.traverse_graph import is_test_file
        searcher = RepoEntitySearcher(graph)
        files = sorted(n for n,d in graph.nodes(data=True) if d['type']=='file' and not is_test_file(n))
        functions = searcher.get_node_data(sorted(n for n,d in graph.nodes(data=True) if d['type']=='function' and not is_test_file(n)), return_code_content=True)
        (root/'jev-inputs'/f'{task["instance_id"]}.json').write_text(json.dumps({'files':files,'functions':functions}))
    marker.write_text(json.dumps({'taskNumber':number,'archiveSha256':inventory['archiveSha256'],'graphNodes':len(graph),'seconds':time.monotonic()-began}))
    print('PREPARED', number, len(graph), flush=True)


def worker():
    # The caller mounts only source, this task, official indexes and dependency caches.
    sys.path.insert(0, '/official')
    os.environ['GRAPH_INDEX_DIR']='/graph'
    os.environ['BM25_INDEX_DIR']='/bm25'
    os.environ['MPLCONFIGDIR']='/tmp/mpl'
    os.environ['TOKENIZERS_PARALLELISM']='false'
    protocol_out=sys.stdout
    def emit(value):
        protocol_out.write('LOCBENCH_JSON '+json.dumps(value)+'\n');protocol_out.flush()
    with contextlib.redirect_stdout(sys.stderr):
        import auto_search_main as upstream
        import litellm
        from util.runtime import function_calling
        from util.prompts.pipelines import auto_search_prompt
        from util.process_output import get_loc_results_from_raw_outputs,merge_sample_locations
        from plugins.location_tools.repo_ops.repo_ops import set_current_issue,reset_current_issue
        task=json.loads(pathlib.Path('/task.json').read_text())
        set_current_issue(instance_data=task)
        raw=[]
        def complete(**kwargs):
            emit({'type':'request','sample':len(raw),'request':kwargs})
            line=sys.stdin.readline()
            if not line:raise RuntimeError('Provider bridge closed')
            response=json.loads(line)
            if 'bridge_error' in response:raise RuntimeError(response['bridge_error'])
            return litellm.ModelResponse(**response)
        # Replace transport only; prompts, tools, loop and result processing remain upstream.
        litellm.completion=complete
        import queue
        for sample in range(2):
            result=queue.Queue()
            messages=[{'role':'system','content':function_calling.SYSTEM_PROMPT},
                      {'role':'user','content':upstream.get_task_instruction(task,include_pr=True,include_hint=True)}]
            tools=function_calling.get_tools(codeact_enable_search_keyword=True,codeact_enable_search_entity=True,codeact_enable_tree_structure_traverser=True,simple_desc=True)
            upstream.auto_search_process(result,model_name='openai/gpt-6-luna',messages=messages,
                fake_user_msg=auto_search_prompt.FAKE_USER_MSG_FOR_LOC,tools=tools,temp=1.0,use_function_calling=True)
            final,_,trajectory=result.get_nowait()
            raw.append(final)
            emit({'type':'sample','sample':sample,'raw':final,'trajectory':trajectory})
        files,modules,functions=get_loc_results_from_raw_outputs(task['instance_id'],raw)
        files,modules,functions=merge_sample_locations(files,modules,functions,ranking_method='mrr')
        emit({'type':'result','instance_id':task['instance_id'],'found_files':files,'found_modules':modules,'found_entities':functions,'raw_output_loc':raw})
        reset_current_issue()


def grade(root):
    root=setup(root)
    from evaluation.eval_metric import evaluate_results
    import datasets
    gold=json.loads((root/'grading-dataset.json').read_text())
    # The official evaluator loads the pinned dataset from a local snapshot.
    dataset_path=root/'official-dataset'
    if not dataset_path.exists():
        dataset_path.mkdir()
        datasets.Dataset.from_list(gold['rows']).to_parquet(str(dataset_path/'test.parquet'))
    ids=[t['instance_id'] for t in json.loads((root/'tasks.json').read_text())]
    output={}
    for model in ['luna','jev']:
        file=root/f'{model}.predictions.jsonl'
        if not file.exists():continue
        df=evaluate_results(str(file),{'file':'found_files','module':'found_modules','function':'found_entities'},dataset=str(dataset_path),split='test',selected_list=ids,metrics=['acc'])
        output[model]={f'{level}/{metric}':float(value) for (level,metric),value in df.iloc[0].items()}
    (root/'official-metrics.json').write_text(json.dumps(output,indent=2));print(json.dumps(output))

if __name__=='__main__':
    if sys.argv[1]=='prepare':prepare(sys.argv[2],int(sys.argv[3]))
    elif sys.argv[1]=='worker':worker()
    elif sys.argv[1]=='grade':grade(sys.argv[2])
