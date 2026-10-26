export interface ApidogMergedRequest {
  id: number; sourceBranchId: number; targetBranchId: number;
  createdById: number; closedById: number; closedAt: string; status: 'MERGED';
}
export interface ApidogCreatedBranch { id: number }
export interface ApidogMr {
  id: number; sourceBranchId: number; targetBranchId: number; createdById: number;
  reviewerIds: number[]; status: 'OPEN' | 'CLOSED' | 'MERGED'; description: string;
  createdAt: string; closedAt: string | null; closedById: number | null;
}
export interface ApidogApi {
  listMergeRequests(input: { projectId: number; targetBranchId: number }): Promise<ApidogMr[]>;
  findMergedRequest(input: { projectId: number; targetBranchId: number; sourceBranchName: string; mergedAtIso: string }): Promise<ApidogMergedRequest | undefined>;
  findCreatedBranch(input: { projectId: number; branchName: string; createdAtIso: string }): Promise<ApidogCreatedBranch | undefined>;
}
type ErrorCode = `http_${number}` | 'timeout' | 'invalid_response' | 'pagination_limit' | 'network';
export class ApidogApiError extends Error {
  constructor(public readonly code: ErrorCode) { super(code); this.name = 'ApidogApiError'; }
}
type Row = Record<string, unknown>;
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApidogApiError('invalid_response');
  return value as Row;
}
const id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function rows(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new ApidogApiError('invalid_response');
  return value.map(object);
}
export function createApidogApi(options: { token: string; fetch?: typeof fetch; timeoutMs?: number }): ApidogApi {
  const fetcher = options.fetch ?? fetch;
  async function withRead<T>(work: (get: (path: string) => Promise<Row>) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new ApidogApiError('timeout')); }, options.timeoutMs ?? 5000);
    });
    async function get(path: string): Promise<Row> {
      if (controller.signal.aborted) throw new ApidogApiError('timeout');
      let response: Response;
      try {
        response = await fetcher(`https://api.apidog.com${path}`, {
          method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${options.token}`, 'X-Apidog-Api-Version': '2026-05-28' },
        });
      } catch { throw new ApidogApiError(controller.signal.aborted ? 'timeout' : 'network'); }
      if (!response.ok) throw new ApidogApiError(`http_${response.status}`);
      let body: Row;
      try { body = object(await response.json()); } catch { throw new ApidogApiError('invalid_response'); }
      if (controller.signal.aborted) throw new ApidogApiError('timeout');
      if (body.success !== true) throw new ApidogApiError('invalid_response');
      return body;
    }
    try { return await Promise.race([work(get), timeout]); }
    finally { clearTimeout(timer); }
  }
  return {
    async listMergeRequests(input) {
      return withRead(async get => {
        if (!id(input.projectId) || !id(input.targetBranchId)) throw new ApidogApiError('invalid_response');
        const result: ApidogMr[] = [];
        const pages = new Set<number>();
        let page: number | null = 1;
        while (page !== null) {
          if (pages.has(page) || pages.size >= 20) throw new ApidogApiError('pagination_limit');
          pages.add(page);
          const query = new URLSearchParams({ page: String(page), perPage: '100' });
          const body = await get(`/api/v1/projects/${input.projectId}/sprint-branches/${input.targetBranchId}/merge-requests?${query}`);
          for (const row of rows(body.data)) {
            if (!id(row.id) || !id(row.sourceBranchId) || row.targetBranchId !== input.targetBranchId || !id(row.createdById)
              || !Array.isArray(row.reviewerIds) || !row.reviewerIds.every(id)
              || (row.status !== 'OPEN' && row.status !== 'CLOSED' && row.status !== 'MERGED')
              || typeof row.description !== 'string' || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))
              || (row.closedAt !== null && (typeof row.closedAt !== 'string' || !Number.isFinite(Date.parse(row.closedAt))))
              || (row.closedById !== null && !id(row.closedById))) throw new ApidogApiError('invalid_response');
            result.push({ id: row.id, sourceBranchId: row.sourceBranchId, targetBranchId: input.targetBranchId,
              createdById: row.createdById, reviewerIds: row.reviewerIds, status: row.status, description: row.description,
              createdAt: row.createdAt, closedAt: row.closedAt, closedById: row.closedById });
          }
          const next = object(body.meta).nextPage;
          if (next !== null && !id(next)) throw new ApidogApiError('invalid_response');
          page = next;
        }
        return result;
      });
    },
    async findCreatedBranch(input) {
      return withRead(async get => {
        if (!id(input.projectId) || !input.branchName || !Number.isFinite(Date.parse(input.createdAtIso))) throw new ApidogApiError('invalid_response');
        const branches = rows((await get(`/api/v1/projects/${input.projectId}/sprint-branches`)).data);
        const second = Math.floor(Date.parse(input.createdAtIso) / 1000);
        const matches = branches.filter(branch => branch.name === input.branchName && branch.projectId === input.projectId
          && branch.type === 'SPRINT' && branch.isMain === false && id(branch.id)
          && typeof branch.createdAt === 'string' && Number.isFinite(Date.parse(branch.createdAt))
          && Math.floor(Date.parse(branch.createdAt) / 1000) === second);
        return matches.length === 1 ? { id: matches[0]!.id as number } : undefined;
      });
    },
    async findMergedRequest(input) {
      return withRead(async get => {
        if (!id(input.projectId) || !id(input.targetBranchId) || !Number.isFinite(Date.parse(input.mergedAtIso))) throw new ApidogApiError('invalid_response');
        const base = `/api/v1/projects/${input.projectId}/sprint-branches`;
        const branches = rows((await get(base)).data).filter(branch => branch.name === input.sourceBranchName);
        if (branches.length !== 1) return;
        const sourceBranchId = branches[0]!.id;
        if (!id(sourceBranchId)) throw new ApidogApiError('invalid_response');
        const path = `${base}/${input.targetBranchId}/merge-requests`;
        const matches = new Map<number, ApidogMergedRequest>();
        const pages = new Set<number>();
        let page: number | null = 1;
        while (page !== null) {
          if (pages.has(page) || pages.size >= 20) throw new ApidogApiError('pagination_limit');
          pages.add(page);
          const query = new URLSearchParams({ sourceBranchId: String(sourceBranchId), status: 'MERGED', page: String(page), perPage: '100' });
          const body = await get(`${path}?${query}`);
          for (const candidate of rows(body.data)) {
            if (candidate.sourceBranchId !== sourceBranchId || candidate.targetBranchId !== input.targetBranchId || candidate.status !== 'MERGED') continue;
            if (!id(candidate.id)) throw new ApidogApiError('invalid_response');
            const detail = object((await get(`${path}/${candidate.id}`)).data);
            if (detail.id !== candidate.id || detail.sourceBranchId !== sourceBranchId || detail.targetBranchId !== input.targetBranchId || detail.status !== 'MERGED') continue;
            if (!id(detail.createdById) || !id(detail.closedById) || typeof detail.closedAt !== 'string' || !Number.isFinite(Date.parse(detail.closedAt))) throw new ApidogApiError('invalid_response');
            if (Math.floor(Date.parse(detail.closedAt) / 1000) !== Math.floor(Date.parse(input.mergedAtIso) / 1000)) continue;
            matches.set(candidate.id, { id: candidate.id, sourceBranchId, targetBranchId: input.targetBranchId, createdById: detail.createdById, closedById: detail.closedById, closedAt: detail.closedAt, status: 'MERGED' });
          }
          const next = object(body.meta).nextPage;
          if (next !== null && !id(next)) throw new ApidogApiError('invalid_response');
          page = next;
        }
        return matches.size === 1 ? matches.values().next().value : undefined;
      });
    },
  };
}
