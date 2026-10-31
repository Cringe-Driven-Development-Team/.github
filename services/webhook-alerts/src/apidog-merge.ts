import type { Delivery, OutgoingMessage } from './store';
import type { ApidogApi } from './apidog-api';
import { escapeHtml, fitHtml, truncate } from './format';
import { parseApidogBranchNotice } from './apidog-notice';
export interface ApidogMergeConfig {
  projectId: number; targetBranchId: number; projectName: string; contractUrl: string;
  reviewers: { name: string; telegramId: string }[];
  peopleMap: Record<string, { name: string; telegramId: string }>;
}
export function parseMergeNotice(payload: unknown, projectName: string): { sourceBranchName: string; mergedAtIso: string } | undefined {
  const notice = parseApidogBranchNotice(payload, { event: 'BRANCH_MERGED', projectName, branchField: 'Merge Sprint Branch', timeField: 'Updated at' });
  return notice ? { sourceBranchName: notice.branchName, mergedAtIso: notice.atIso } : undefined;
}
export async function formatApidogMerge(delivery: Delivery, base: OutgoingMessage, api: Pick<ApidogApi, 'findMergedRequest'>, config: ApidogMergeConfig): Promise<OutgoingMessage> {
  if (delivery.source !== 'apidog' || delivery.event !== 'BRANCH_MERGED') return base;
  const { button: _button, secondaryButton: _secondary, ...rest } = base;
  const fallback = { ...rest, button: { text: 'Контракт API', url: config.contractUrl } };
  const notice = parseMergeNotice(JSON.parse(new TextDecoder().decode(delivery.raw)), config.projectName);
  if (!notice) return fallback;
  let mr;
  try { mr = await api.findMergedRequest({ projectId: config.projectId, targetBranchId: config.targetBranchId, ...notice }); }
  catch { console.error(JSON.stringify({ errorCode: 'apidog_merge_lookup_failed' })); return fallback; }
  if (!mr) return fallback;
  const seen = new Set<string>();
  const person = (id: number): string => {
    const entry = Object.hasOwn(config.peopleMap, String(id)) ? config.peopleMap[String(id)] : undefined;
    if (!entry) return `Apidog user ${id}`;
    const name = escapeHtml(truncate(entry.name, 100));
    if (!/^[1-9]\d{0,19}$/.test(entry.telegramId) || seen.has(entry.telegramId)) return name;
    seen.add(entry.telegramId);
    return `<a href="tg://user?id=${entry.telegramId}">${name}</a>`;
  };
  const roles = `Создатель MR: ${person(mr.createdById)}\nСлил MR: ${person(mr.closedById)}`;
  return { ...rest, html: `${fitHtml(base.html, 4094 - roles.length)}\n${roles}`,
    button: { text: 'Открыть MR', url: `https://app.apidog.com/project/${config.projectId}/branch/${config.targetBranchId}/merge-request/${mr.id}` },
    secondaryButton: fallback.button };
}
