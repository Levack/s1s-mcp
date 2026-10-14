# Paired LLM benchmark comparison

Run the same coding agent against the 50-task [MariusHobbhahn Mini dataset](https://huggingface.co/datasets/MariusHobbhahn/swe-bench-verified-mini), once with ordinary shell tools and once with this project's s1s MCP tools. Both conditions use the same solver model, base task prompt, temperature, seed, step limit and isolated repository snapshot. Initial system/user messages are identical. The only model-visible addition is the MCP tool definitions; all MCP calls and arguments are chosen by the solver. This Mini dataset contains Django and Sphinx tasks; it is not representative of every SWE-bench repository.

## Benchmark selection

Choose a benchmark in the terminal wizard, or pass `--bench`:

```sh
mise run benchmark --bench swe-bench-mini --limit 1
mise run benchmark --bench loc-bench --limit 3
mise run benchmark --bench loc-bench --dry-run --output benchmark/results/loc-dry
```

The default is `swe-bench-mini` (50 tasks). `loc-bench` uses the official
[Loc-Bench V1](https://huggingface.co/datasets/czlll/Loc-Bench_V1) (560 tasks).
Both use the same paired agent, accounting, traces and alternating condition order.
The default limit remains 50; use `--limit 560` for the full Loc-Bench dataset.
JSON configuration accepts `"bench": "loc-bench"`; the dataset is selected automatically.
An explicit dataset must match the selected benchmark.

Loc-Bench asks the agent to find modification locations rather than implement a patch.
Its `finish` tool accepts ranked `files` (up to 10) and `functions` (up to 15).
Function IDs use `path/to/file.py:Class.method` or `path/to/file.py:function`.
Reports include File Acc@5/10 and Function Acc@10/15, plus total API cost, time
and MCP usage. Gold labels come from `edit_functions`, as in the
[authors' evaluator](https://github.com/gersteinlab/LocAgent/blob/master/evaluation/eval_metric.py).
Files are derived from those edited functions; newly added functions are excluded.
Constructor names ending in `.__init__` normalize to the class name.
All gold locations must appear within the top k unique predictions. Unlike the authors'
implementation, this runner does not truncate gold to k when an issue changes more
than k locations; such issues score zero at that k. Do not assume exact paper-score parity.
Failed or missing submissions score zero and stay in the denominator.

Preparation clones public repositories, archives the specified base commits and builds
source-only Docker images with Python, bash, git and ripgrep. Project dependencies are
not installed. Images record the pinned base-image digest and built image IDs.
Containers have no network, repository history, host mounts, gold labels or API keys.
Loc-Bench grading runs on the host without test execution. `grading-dataset.json`
contains gold data, `*.predictions.jsonl` contains ranked locations, and `*.grades.json`
contains per-issue coverage for each metric. Report regeneration reads the stored
benchmark selection, so `--mode report` does not need `--bench`.

## Select tasks

Use ordinary CLI flags for either benchmark:

```sh
mise run benchmark --bench loc-bench --range 1-10
mise run benchmark --bench swe-bench-mini --range 1,3,5-8
mise run benchmark --bench loc-bench --instance-ids owner__repo-123,owner__repo-456
```

Replace the example instance IDs with IDs from the selected dataset.
Numbers are **1-based positions in the full dataset sorted by `instance_id`**,
not GitHub issue numbers. Both endpoints are included. Comma-separated numbers
and ranges can be combined; overlaps are deduplicated and run in ascending order.
Mini accepts numbers 1–50 and Loc-Bench 1–560. Numbers refer to the pinned dataset
revision recorded in `dataset.json`; that file also records selected `taskNumbers`
and their `instanceIds`, and `tasks.json` includes each task's number.

`--range` and `--instance-ids` select exactly those tasks; `--limit` applies only
when neither selector is present. Invalid ranges, unknown IDs, duplicate IDs and
using both selectors fail. Direct selection flags replace a selector from JSON
configuration. A prepared run must use matching selection settings.
Dry runs use synthetic IDs (`dry-run-001`, etc.); explicit ranges exercise the
selected number of synthetic tasks, while a dry run without a selector uses up to two.

## Start

Install the project's tools and packages (`mise install`, `pnpm install --frozen-lockfile`). Live runs need Docker with access to its daemon, plus Git for Loc-Bench source archives. All repository benchmark code and tests are TypeScript. Dataset snapshots are read directly from revision-pinned Hugging Face Parquet files. Host Python and uv are not required. SWE-bench grading uses the unmodified official swebench 4.1.0 CLI inside a dedicated Docker image; Python runs inside that image and the Python task containers. The image is built on first preparation, reused locally, and its immutable image ID is recorded in `harness-image.json`. Official grading requires a local Unix Docker socket, mounted only into the trusted harness container; solver containers never receive that socket or the output directory. The trusted official harness uses network access to read upstream environment specifications; solver containers remain offline.

Check the complete pipeline without downloads or paid API calls:

```sh
mise run benchmark --dry-run --output benchmark/results/dry-run
mise run benchmark --help
```

Dry runs use up to two synthetic tasks by default (or the explicit selection), simulated completions and simulated grading, while exercising the real MCP server with a simulated Jev provider. They do not measure accuracy, cost or speed.

Run the benchmark interactively in a terminal:

```sh
mise run benchmark
```

With no arguments, the terminal wizard lets you choose a paired evaluation, preparation, dry run, or report regeneration, then the benchmark. For evaluation it asks for the solver/Jev model IDs, step limit, repetitions, per-attempt time limit, task count and results directory. Press Enter to accept defaults or Ctrl+C to cancel before execution. Login follows the settings when needed. A full run defaults to 50 tasks in each condition.

Commands with flags run directly. Add `--interactive` to edit their defaults in the wizard:

```sh
mise run benchmark --interactive --model qwen/qwen3-coder-next --limit 3
```

Noninteractive callers use flags and do not receive settings prompts. `--interactive` requires a terminal.

Both the coding model and Jev use **OpenRouter and the same API key**. The default solver is `qwen/qwen3-coder-next` and the default s1s model is `jev-latest`. An existing TypeSafe provider configuration does not change the benchmark provider or endpoint. For `openai/gpt-6-luna`, the Chat Completions solver sends `reasoning_effort: "none"` because that endpoint supports its function calling only without reasoning, and omits `temperature` because OpenRouter does not advertise support. These effective settings apply equally to both conditions and differ from the stored general temperature default; request traces record the solver messages and responses. This does not evaluate Luna with reasoning enabled.

The runner reads `OPENROUTER_API_KEY` (also accepting `OPEN_ROUTER_API_KEY`) from the environment or project `.env`. If neither is present, it reuses credentials saved by OpenRouter login. Without a key or saved credentials, an interactive terminal automatically starts the existing OpenRouter browser login and continues after authorization. In a noninteractive terminal it exits with instructions to log in or set the key, before Docker preparation or paid calls.

You can log in ahead of time:

```sh
mise run login-openrouter
# Alternatively:
export OPENROUTER_API_KEY=...
```

OAuth credentials are saved by the existing login command with mode 0600. No key is written to `.env`, run configuration or Docker containers. The optional JSON `apiKeyEnv` setting selects a different environment variable containing an OpenRouter key; the selected key is shared by the solver and s1s. Dry runs, preparation and report generation do not require login.

Start with one real task, then run all 50:

```sh
mise run benchmark --model qwen/qwen3-coder-next --limit 1 \
  --max-steps 30 --output benchmark/results/qwen-smoke

mise run benchmark --model qwen/qwen3-coder-next --limit 50 \
  --max-steps 60 --repetitions 1 --output benchmark/results/qwen-50
```

A full repetition means **100 solving attempts**: 50 per condition. The default model is `qwen/qwen3-coder-next`, an inexpensive coding model currently offered on OpenRouter. Its actual latency depends on provider routing and must be measured. Model IDs are configurable and may change availability.

Prepare data and Docker images separately, with no solver calls:

```sh
mise run benchmark --mode prepare --limit 50 --output benchmark/results/prepared
mise run benchmark --limit 50 --output benchmark/results/prepared
```

Preparation pins the resolved Hugging Face revision and records Docker image IDs/digests. Pulls and dependency setup are excluded from solving time. The first preparation needs network access and several GB of storage; Docker retains images for reuse. A prepared directory can be consumed once, using matching dataset selection settings. Existing attempts are never overwritten. Choose a new directory to rerun; automatic paid retries/resume are intentionally absent.

## Parameters

Use direct flags such as `--bench`, `--range`, `--instance-ids`, `--model`, `--limit`, `--max-steps`, `--max-output-tokens`, `--timeout-seconds`, `--concurrency`, `--repetitions`, `--s1s-provider`, `--s1s-model`, `--base-url` and `--output`. `--help` lists them.

Optional JSON configuration covers more settings. Direct flags override it:

```sh
mise run benchmark --params benchmark/params.example.json --limit 1
mise run benchmark --params '{"model":"qwen/qwen3-coder-next","limit":3,"seed":42}'
```

See `params.ts` for all validated settings. JSON additionally supports specific `instanceIds`, dataset `revision`, CPU/memory/PID limits, command/API/grading timeouts, `temperature`, `seed`, and s1s concurrency/batch size. Defaults: 50 tasks, concurrency 1, one repetition, 60 solver calls, 4,096 output tokens per call, 1,200 seconds per attempt, 2 CPUs and 4 GB per solver container. Parameter names are strict; misspellings fail before execution.

API costs use the provider's reported `usage.cost`. If s1s or another compatible API returns only token counts, provide **your verified prices** in USD per million tokens:

```json
{
  "s1s": {
    "pricing": {
      "inputUSDPerMillion": 0.1,
      "outputUSDPerMillion": 0.1
    }
  }
}
```

Those numbers are illustrative, not Jev prices. `solverPricing` accepts the same fields. Reported costs always take precedence. Fallback costs are labeled estimates and ignore cache discounts; they are not billing measurements. Missing costs remain `null`/N/A, and `knownCostUSD` is a lower bound. Failed or timed-out API calls can be billed without returning usage. s1s SDK retries and solver retries are disabled to avoid silently omitting their cost.

## Outputs and interpretation

Historical delivery experiments are retained for interpretation only. The current runner rejects all delivery overrides: no extra system instructions, prefetch, fixed arguments, tool selection, schema compaction or evidence rewriting. Earlier prefetch results are not tools-only comparisons.

Each output directory contains:

- `results.md`: comparison of accuracy, total solver+s1s API cost, mean solving time, errors and actual MCP usage, plus a call-count table for each condition.
- `results.csv`: per-task/repetition/condition metrics, including setup and grading time separately.
- `summary.json`: summaries, full rows and paired cost/time differences (`s1s - baseline`).
- `params.json`, `run.json`, `dataset.json`, `tasks.json`: effective settings, environment, immutable dataset revision, selected IDs and Docker image identities.
- `attempts.json`: persistent attempt records, including pending attempts on interrupted runs.
- `traces/`: solver requests/responses and MCP/provider call histories; no authorization headers.
- `*.predictions.jsonl`: submitted diffs in the official harness format.
- `*.grades.json`, `grading-*/logs/`: official grading outcomes and test logs.
- `grading-dataset.json`: host-only gold/test data, never given to the solver.
- `harness-image.json`: pinned official grading image identity (SWE-bench only).

Call counts are available per attempt in `results.csv` and per condition in
`summary.json` and the `results.md` call-count table:

- `solverCalls`: LLM API requests, including failed requests.
- `s1sProviderCalls`: s1s inference API requests, counting each internal batch separately.
- `totalApiCalls`: `solverCalls + s1sProviderCalls`.
- `mcpCalls`: MCP tool invocations; these are separate from API requests.

One `filter_files`, `rate_files` or `classify_files` invocation can make several inference requests, so MCP and
provider call counts can differ. API counts include observed failures; they do not
count unobservable provider-internal requests. Existing saved attempts already contain
these counters: regenerate a report to add the new columns without paid calls.

Accuracy means the official SWE-bench **resolved** criterion: the expected failing tests pass and previously passing tests remain passing. All scheduled attempts remain in the denominator, including empty patches, timeouts and infrastructure errors. Until all grades exist, accuracy is N/A. Grading failures produce a nonzero process exit after saving reports. Regenerate reports without API calls:

```sh
mise run benchmark --mode report --output benchmark/results/qwen-50
```

Each solver runs in a fresh container at `base_commit`. Network, host mounts, API keys, repository history/remotes and setup scripts are unavailable to the solver. The agent can read/edit/test with `bash`; patches include new files. The correct patch, hints, held-out test patch and test lists are excluded from the agent task. Grading uses fresh official environments after solving, with no hidden-test feedback to the agent.

The s1s condition exposes the two real MCP tools (`search_file_names` and `search_file_contents`) through the SDK's in-memory transport. Descriptions and schema properties come from the server; top-level `oneOf` is omitted for API compatibility while the MCP handler retains validation. There are no synthesized files/texts tool variants or tool-name corrections. MCP initialization instructions are not appended to the prompt. Calls receive the exact model-supplied arguments, and the full MCP response is returned without benchmark-specific evidence rewriting.

The model starts with the same system and issue messages in both conditions. There is no automatic search, injected tool history, or source-language restriction. On a model-selected MCP call, the container's current working tree is mirrored to the host MCP root, replacing the preceding mirror so edits, additions and deletions are visible. `.git` is excluded; MCP retains its normal path protections. This filesystem bridge is infrastructure, not search guidance; its time remains charged to the MCP call and solve time. No source export or provider evaluation runs before the first solver request. The temporary mirror is removed afterward. `mcpUsedAttempts`, `mcpCalls` and `mcpErrors` distinguish availability from use; all provider calls are charged.

Task pairs run sequentially by default (`--concurrency 1`). Use `--concurrency 4` to evaluate up to four task pairs at once. The two conditions within each pair remain sequential, and repetitions and grading remain sequential. Results and predictions are saved through a serial write queue so concurrent attempts cannot overwrite reports. More concurrency uses more memory and can change latency through API limits or host contention. Per-attempt times and total API costs are still recorded; summed solving time is not wall-clock runtime in parallel mode. `run.json` records `executionWallMs` for the task execution phase, including container setup and result persistence, excluding preparation and grading. Condition order alternates per task and repetition to reduce order effects; it is deterministic from the configured seed. Sampling takes sorted IDs, so a small `--limit` is a plumbing check rather than a representative score. Repetitions produce additional independent attempts and are pooled in the summary. Seed settings do not guarantee deterministic API routing or outputs. No significance claim is made from a single 50-task run.

## Development checks

`pnpm check` runs TypeScript checks, application and benchmark tests, and the build.
Dataset preparation, source isolation, official harness invocation and parallel scheduling are covered by the same TypeScript test suite. Tests use local Git fixtures and simulated Docker APIs without paid model calls.

## Sources

- [Mini dataset construction](https://github.com/mariushobbhahn/SWEBench-verified-mini)
- [Official SWE-bench evaluation](https://www.swebench.com/SWE-bench/guides/evaluation/)
- [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)


## Tool usage schema

Attempt results and `summary.json` rows store tool usage under a dynamic `tools` map:

```json
{
  "tools": {
    "s1s_rank_paths": { "calls": 2, "errors": 0, "durationMs": 1200 },
    "bash": { "calls": 14, "errors": 1, "durationMs": 2300 }
  }
}
```

Keys are the actual called tool names. Adding or renaming a tool only changes map entries, not the result schema or CSV columns. Condition summaries use the same map and add `usedAttempts` to each entry. `results.md` renders a table from the discovered keys; `results.csv` stores the entire map in one JSON `tools` column. Provider API batch calls remain separate from tool invocation counts. Calls include failed invocations; errors include MCP error responses, argument/transport failures, timeouts and shell nonzero exit codes. A recovered tool error does not imply an unsuccessful solver attempt.

Report regeneration reconstructs missing maps in historical runs from `traces/*.jsonl` without rerunning solver or provider calls. A missing trace cannot recover tool usage and yields an empty map. Existing `mcpCalls`/`mcpErrors` totals remain available for compatibility.
