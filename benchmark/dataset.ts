import { z } from 'zod';
import { parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { benches, parseRange, type Params } from './params.js';

const rowSchema = z.object({
  instance_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
  repo: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  base_commit: z.string().regex(/^[a-f0-9]{40}$/),
  problem_statement: z.string(),
  edit_functions: z.array(z.string()).optional(),
}).passthrough();
export type DatasetRow = z.infer<typeof rowSchema>;

export function selectRows(rows: DatasetRow[], params: Params) {
  const sorted = [...rows].sort((a, b) => a.instance_id < b.instance_id ? -1 : a.instance_id > b.instance_id ? 1 : 0)
    .map((row, index) => ({ ...row, taskNumber: index + 1 }));
  if (params.range) {
    const numbers = new Set(parseRange(params.range, rows.length));
    return sorted.filter(row => numbers.has(row.taskNumber));
  }
  if (params.instanceIds) {
    const ids = new Set(sorted.map(row => row.instance_id));
    const missing = params.instanceIds.filter(id => !ids.has(id));
    if (missing.length) throw new Error(`Unknown instance IDs: ${missing.join(', ')}`);
    return sorted.filter(row => params.instanceIds!.includes(row.instance_id));
  }
  return sorted.slice(0, params.limit);
}

export async function loadDataset(params: Params, request: typeof fetch = fetch) {
  const get = async (url: string) => {
    const response = await request(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Dataset HTTP ${response.status}`);
    return response;
  };
  const manifest = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/), siblings: z.array(z.object({ rfilename: z.string() })) })
    .parse(await (await get(`https://huggingface.co/api/datasets/${params.dataset}/revision/${encodeURIComponent(params.revision)}`)).json());
  const files = manifest.siblings.map(f => f.rfilename).filter(f => /^data\/test-[^/]+\.parquet$/.test(f)).sort();
  if (!files.length) throw new Error('Dataset has no test Parquet files');
  const rows: DatasetRow[] = [];
  for (const file of files) {
    const bytes = await (await get(`https://huggingface.co/datasets/${params.dataset}/resolve/${manifest.sha}/${file}`)).arrayBuffer();
    rows.push(...z.array(rowSchema).parse(await parquetReadObjects({ file: bytes, compressors })));
  }
  const expected = benches[params.bench].size;
  if (rows.length !== expected || new Set(rows.map(row => row.instance_id)).size !== expected) {
    throw new Error(`Expected exactly ${expected} unique tasks`);
  }
  return { revision: manifest.sha, rows: selectRows(rows, params) };
}
