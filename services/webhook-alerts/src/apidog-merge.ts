import type { Delivery, OutgoingMessage } from './store';
import type { ApidogApi } from './apidog-api';
import { escapeHtml, fitHtml, truncate } from './format';
export interface ApidogMergeConfig {
  projectId: number; targetBranchId: number; projectName: string; contractUrl: string;
  peopleMap: Record<string, { name: string; telegramId: string }>;
}
export function parseMergeNotice(payload: unknown, projectName: string): { sourceBranchName: string; mergedAtIso: string } | undefined {
  if (!payload || typeof payload !== 'object') return;
  const body = payload as Record<string, unknown>;
  if (body.event !== 'BRANCH_MERGED' || typeof body.content !== 'string') return;
  const content = body.content;
  const field = (label: string): string | undefined => {
    const values = content.split(/\r?\n/).filter(line => line.startsWith(`${label}:`));
    if (values.length !== 1) return;
    return values[0]!.slice(label.length + 1).trim() || undefined;
  };
  const sourceBranchName = field('Merge Sprint Branch');
  const date = field('Updated at');
  if (!sourceBranchName || field('Project') !== projectName || !date || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date)) return;
  const iso = date.replace(' ', 'T') + '.000Z';
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== iso) return;
  return { sourceBranchName, mergedAtIso: iso };
}
export async function formatApidogMerge(delivery: Delivery, base: OutgoingMessage, api: ApidogApi, config: ApidogMergeConfig): Promise<OutgoingMessage> {
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
