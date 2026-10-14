# MCP delivery experiments

The delivery profiles below describe historical experiments, not the current allowed comparison. The runner now rejects those overrides. `swe.ts <new-stage>` runs three paired tasks with identical initial messages and optional MCP tools only; do not set `EXPERIMENT_VARIANT`. Earlier prefetch results do not establish a tools-only MCP advantage. Existing artifacts and their manifests are retained unchanged.

`run.ts` compares delivery variants through the real MCP handlers on already prepared Loc-Bench snapshots. It uses a fresh offline container per attempt, the same solver settings, rotating condition order, and host-only gold grading after submission. `manifest.json` records prompts, tool selection, model pricing and task IDs; traces retain complete requests, raw tool results and provider responses. Do not pool different stages or task selections as if they were a controlled comparison.

The experiment budget is shared across stages in `delivery-experiments-2026-10-09/budget.json`. The stop line is $4 against an authorized $5 ceiling. Each request reserves a conservative allowance before starting. Solver allowances use the current model catalog and serialized input bytes as a conservative token bound; Jev calls are limited to 48 KB and reserve $0.05. Missing billing or failed requests stop further paid calls. SDK retries are disabled. Only one experiment process may use a budget file at a time. Never delete the ledger to resume a stopped budget.

Examples (paid API calls and Docker required):

```sh
mise exec -- node --import tsx benchmark/experiments/run.ts pilot
EXPERIMENT_VARIANTS=baseline,all_names,all_names_content \
  EXPERIMENT_TASKS=1,2,5,7,9,10 \
  mise exec -- node --import tsx benchmark/experiments/run.ts all-filenames
mise exec -- node --import tsx benchmark/experiments/report.ts
```

`EXPERIMENT_MODEL`, `EXPERIMENT_REPETITIONS`, `EXPERIMENT_TASKS` and `EXPERIMENT_VARIANTS` select the experiment. Existing stage directories cannot be overwritten. Report generation is offline and makes no paid calls.

The variants isolate the old procedural guide, removal of duplicate MCP envelope content, a concept-oriented guide, a restricted tool set, bounded content search with returned snippets, automatic all-filename noul decisions, and filename ranking followed by shortlisted content inspection. The old variants keep their original tool set even when new tools are registered.

`filename-micro.ts <new-stage-name>` compares the real MCP filename-ranking handler against one LLM request returning top ten paths, on identical captured inventories and original issue text. It runs five rotated repetitions for task numbers 2, 5 and 9. This measures filename triage only. It uses the same shared budget and must not run concurrently with `run.ts`.

The initial filename experiment put paths only in output keys and used identical question instructions. Its near-uniform scores exposed an input-binding error. The corrected handler also supplies `candidate_path` explicitly in every question. Preserve both sets of results; do not treat the initial filename/controller stages as measurements of the corrected implementation. The earlier `rank_paths` and content-screening handlers already supplied candidate evidence explicitly.

The later compact format supplies the candidate path directly as the question's `instructions` string and shares the relevance definition in `state`. `single-request.ts` compares seven captured batches with all 811 questions in one provider request. The unchanged verbose combined request was rejected with HTTP 400 `max_tokens_exceeded`; the compact request succeeded. `EXPERIMENT_METHODS` selects conditions and the first argument selects a fresh output directory. `EXPERIMENT_MAX_BATCH_BYTES=128000` enables the compact full-inventory MCP check in `filename-micro.ts`.

Budget recovery is restricted to recorded HTTP 400 token-limit or null-criteria validation rejections: `EXPERIMENT_COVER_REJECTION` explicitly accepts the failed request's entire reservation as an ongoing liability. Its reported cost remains unknown, and the allowance is never released or counted as confirmed provider spend. Other missing billing and request failures still stop paid work.

`prefetch_content3` is a separate orchestration experiment: it calls the real MCP tool with the original issue before the first solver request, ranks all Python filenames, and inspects the top three files. All retrieval time and provider charges are included. The trace marks this call `origin: "prefetch"`; it is not an LLM-selected action. Ordinary MCP clients do not automatically perform this step. `swe.ts` runs a three-task official SWE-bench check of this configuration against baseline with the same shared budget.

To repeat the paired coding comparison with the compact candidate inputs and the larger byte budget, use `S1S_MAX_BATCH_BYTES=128000 mise exec -- node --import tsx benchmark/experiments/swe.ts <new-stage-name>`. Both arms rerun the same three pinned tasks; only the MCP implementation and byte budget differ from the earlier experiment. Larger repositories can still span several filename requests. The runner records the delivery configuration, byte budget, and source snapshots before solving and retains separate filenames/content provider calls in traces.

`EXPERIMENT_VARIANT=prefetch_lean` additionally exports only `**/*.py` into the MCP snapshot and fixes `snippetThreshold=0.5`. The solver is told to use bash for other files and current edits. The full repository remains available to bash in both arms, and source export time remains included in solve time. Low-scoring content candidates retain their paths/scores/line ranges instead of injecting source text. This variant measures the combined implementation and delivery changes, not an isolated batching effect.

`judgment-modes.ts <new-stage-name>` compares noul and five-level score judgments on the same filename inventories and preselected code snippets, with three rotated repetitions. Score labels are explicit: although SDK types allow null criterion descriptions, the observed provider rejected null criteria. Optional topK/threshold projections reuse the same complete answers and incur no extra provider calls. The score-backed `rate_files` returns all results by default; both return filters are optional.

## October 12 efficiency and one-call experiments

`efficiency.ts <fresh-stage>` compares optional tools on the existing ten Loc-Bench snapshots. `EXPERIMENT_TASKS`, `EXPERIMENT_REPETITIONS`, and `EXPERIMENT_ARMS` select runs. All stages share the new `efficiency-2026-10-12/budget.json` ledger: an additional $5 authorization, with a $4.50 stop line. The October 9 ledger is unchanged. Run only one paid experiment process at a time.

`efficiency-keys.ts` replays captured filename requests with path keys, short IDs, and short IDs repacked into fewer 48 KB batches. Candidate inventories and query text remain identical. It measures provider encoding/batching, not complete agent behavior.

`efficiency-one-call.ts <fresh-stage>` measures a different workflow explicitly requested for one-call search: the controller sends the original issue to `search_code` exactly once, then a single consumer completion submits locations with no further retrieval. It compares this against the normal shell-search agent. Timing includes source export, retrieval and consumer completion. There is no initial model planning call for the one-call arm, so this is not a tools-only causal comparison. Raw evidence recall is recorded separately from the consumer's final answer. The validation task numbers 1,3,4,6,7,8,10 were excluded from this session's tuning.

`EXPERIMENT_RESUME=1` resumes only unrecorded attempts in an existing one-call stage with an identical manifest. It preserves original source snapshots and writes separate resume snapshots. An invalid model response is a failed attempt, not a reason for a paid retry. The validation stage contains one explicitly documented recovery from an earlier runner JSON-parse exception; its full billed cost and failed grade are retained, while unavailable timing/trace data remain marked unavailable.

Run `/usr/bin/python3 benchmark/experiments/efficiency-report.py` to regenerate offline result tables and the ledger summary. Reports do not initiate paid requests. These experiments use pinned historical public repository snapshots and small samples; they are localization measurements, not official bug-fix success rates.

## Search-only System One localization

`retrieval-only.ts <fresh-stage>` removes both the planning model and the final answer model. It uses the unchanged issue and returns ranked file/function IDs directly from Jev `noul` judgments. `EXPERIMENT_TASKS`, `EXPERIMENT_REPETITIONS` (1–3), and `EXPERIMENT_ARMS` select attempts. It shares the existing October 12 budget; never run two paid runners concurrently.

Available arms:

- `current`: existing `search_code`; function IDs are projected deterministically from returned chunk spans for evaluation, not supplied natively by that tool.
- `names_bodies`: semantic filename shortlist, then independent function-body edit-likelihood judgments.
- `names_signatures`: semantic filename shortlist, then declarations and short docstrings only.
- `names_signatures_bodies`: declaration/docstring judgments shortlist 40 functions before body judgments.
- `lexical_bodies`: local filename word overlap replaces semantic filename judgments.
- `symbols_bodies` / `symbols_signatures`: a local Python AST index and BM25 replace filename judgments entirely; Jev evaluates up to 40 candidate bodies or declarations/docstrings.

All provider questions share the issue once per request, use short answer IDs, and pack to 48 KB with four concurrent batches. All source parsing uses `ast.parse`, never repository imports or execution. Input clipping, candidate limits and extraction failures remain limitations; a low score is not proof of irrelevance. Unsupported languages count as function-localization failures. The current comparator's function projection is weaker than native function classification and must be labeled accordingly.

Timing includes local discovery, source reads and AST extraction, and excludes shared Docker startup/source export. Index time is recorded separately; subtracting it gives an estimate, not a measured warm-cache benchmark. Gold is read only after predictions. The symbol-index arms were designed after observing the first validation failures: their follow-up results are exploratory, not an untouched holdout. No production search defaults are changed by these experiment runners.

Example: `EXPERIMENT_TASKS=2,5,9 EXPERIMENT_ARMS=symbols_bodies,symbols_signatures mise exec -- node --import tsx benchmark/experiments/retrieval-only.ts <fresh-stage>`.

`python3 benchmark/experiments/retrieval-report.py` regenerates the separate search-only report. `python3 benchmark/experiments/test_python_symbols.py` checks declaration extraction; the local ranking regression tests are under `tests/benchmark/retrieval-ranking.test.ts`.

## Direct Jev versus GPT ranking (no MCP)

`direct-model-ranking.ts` compares `jev-latest` and `openai/gpt-6-luna`
using direct provider requests. It uses the ten previously explored Loc-Bench
issues, with identical captured candidate evidence and identical batches for both
models. It measures filename ranking and function-body ranking separately.
Jev supplies `noul` probabilities; GPT uses Structured Outputs with a strict
JSON Schema requiring every candidate's numeric probability (0–1), with no extra
fields and reasoning disabled. OpenRouter routing requires parameter support.
Refusals, incomplete responses and invalid scores fail explicitly; no JSON-mode
fallback or explanation-text extraction is used. No MCP server, tools, agent
loop, or final-answer model is involved.

```sh
# Offline preparation, no credentials or paid calls:
mise exec -- node --import tsx benchmark/experiments/direct-model-ranking.ts prepare <fresh-stage>
# Live comparison after making API allowance available:
mise exec -- node --import tsx benchmark/experiments/direct-model-ranking.ts run <fresh-stage>
```

Preparation stores the evidence, its SHA-256 hash, task provenance, model IDs,
batch counts and runner snapshot. The live run checks the configured key's
remaining allowance first. It uses a new $1 maximum ledger for this comparison;
it does not reset historical ledgers or change the API key limit. `EXPERIMENT_BUDGET_USD`
can lower the prepared ceiling to keep reruns within the original total budget.
Calls run
sequentially with alternating model order and no retries. Provider failure,
unknown billing or insufficient budget stops the run with partial results saved.
Existing live stages cannot be overwritten or resumed. Outputs are ignored by
Git under `benchmark/results/direct-model-ranking/`.

**Scope:** the filename inventory is the complete eligible inventory captured by
the earlier run. Function bodies come from its Jev-selected shortlist, with its
original clipping; neither model gets gold labels. Function scores are therefore
conditional reranking measurements and may favor that historical shortlist.
This is not independent full-repository search, official end-to-end Loc-Bench,
or an untouched validation set. Missing gold candidates cannot be recovered.
Both arms use 64-candidate / 40 KB batches rather than separately optimized
serving strategies. Report accuracy, latency, calls and cost together; do not
compare these timings directly with prior agent or one-call experiments.

## First 100 tasks: Jev, GPT-6 Luna and Sonnet 5

`direct-model-suite.ts run <output>` runs the separately authorized $30 comparison
with a $29.50 ledger stop line. The prepared directory contains task numbers 1–100
in instance-ID order at dataset revision
`c44cf3b74e07ca642cec841b471a9939907c12a7`. `direct-source.py prepare <output>`
downloads public archives at each exact base commit and records their SHA-256
hashes and complete eligible inventories. It reads archives as data without
extracting paths or executing repository code. Preparation uses no model calls.

All three models score every eligible Python filename; this differs from the
older all-extension experiment. Function candidates come from Jev's top five
Python files, deterministic lexical selection of at most 160 functions, and
6000-byte body clipping. Candidates and batch boundaries are identical across
models. Gold enters only offline reporting. Shared Jev selection can bias the
function comparison; candidate coverage is reported per task. Neither this nor
the preceding direct comparison is the official LocAgent evaluation pipeline.

The models are exactly `jev-latest`, `openai/gpt-6-luna`, and
`anthropic/claude-sonnet-5`. GPT and Sonnet use strict Structured Outputs; explicit
reasoning is disabled. Each model runs four concurrent batches, with models
sequential and their order rotated by task. After task 60, the user requested
four concurrent tasks (at most 16 requests). The shared ledger reserves all
in-flight costs and report writes are serialized. Original artifacts are kept
in `serial-phase/`; `parallel-transition.json` records the change. Timing means
are reported separately for each phase. Latency is not directly comparable
with the earlier sequential run. Source snapshots and hashes fix the protocol.
The runner intentionally uses saved user login credentials, avoiding a stale
project `.env` key.

Batch requests/responses, request hashes, individual timing, billing, inputs and
per-condition results are persisted. Re-running the identical command reuses
saved responses; failed requests are not retried. Unknown billing or exhausted
budget stops new requests while in-flight requests settle. A lock prevents two
runners sharing the ledger. A stale lock after an external process kill requires
inspection of the ledger and process state before removal. Do not reset it or
the ledger to bypass a billing stop. `report` regenerates the report without
API calls. Planned denominators remain 100, with recorded/completed counts shown
separately for partial runs. No package or production source is changed.

## Independent Loc-Bench comparison

`independent-locbench.ts run [last-task-number]` evaluates the same first 100
pinned tasks with two independent solvers. GPT-6 Luna uses the unmodified
`auto_search_process`, prompts, search tools, output parser and MRR merger from
LocAgent commit `4935b557326c154bad8e8dcf3747cc8d32d1f387`, with two samples and
`simple_desc=True`. The adapter replaces API transport, omits unsupported Luna
temperature, limits responses to 16,384 tokens, and imposes a 900-second task
watchdog. This is an upstream LocAgent search-policy run with documented
transport/runtime adaptations, not a model-only ranking comparison.

Jev runs independently: it scores the official graph's non-test Python file
names, selects its own top ten files, then scores all function nodes within
those files, with source clipped to 6000 bytes. No Luna outputs or gold labels
enter this path. Jev's search strategy is custom and explicitly authorized;
its results must not be described as an unmodified LocAgent solver.

Both solvers are graded by the unmodified official `evaluate_results`, reading
a local snapshot of the pinned dataset. Official default File Acc@1/3/5,
Module Acc@5/10 and Function Acc@5/10 are preserved, including the upstream
handling of more gold locations than k. No prior experiment's predictions are
reused. Graphs and BM25 indexes are prepared with the upstream builders.

Workers run in a network-isolated filesystem namespace with only the official
source, dependency environment, task metadata and source indexes mounted. They
cannot access host API keys, benchmark gold, or the other model's outputs.
API calls and billing remain in the host controller. Four tasks can run at once;
Jev batches use concurrency four. The additional ledger stop line is $5.40,
within the previously authorized $30 combined cap. The rejected temperature
preflight retains its full reservation as an unknown liability and is recorded
separately; it is never reported as known zero cost. Installed dependencies,
upstream hashes, adapter snapshots, requests, responses and predictions are
saved with the run. LiteLLM 1.53.1 replaces unavailable upstream pin 1.52.1;
the official search source is unchanged. `report` invokes official grading
without paid calls; missing predictions remain in the planned denominator.
