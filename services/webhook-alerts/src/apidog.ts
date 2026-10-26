import type { Delivery, OutgoingMessage } from './store';
import type { ApidogMergeConfig } from './apidog-merge';
import { escapeHtml, fitHtml, mention, safeUrl, truncate } from './format';

export interface FormatConfig { apidogTopic: number }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';

// Observed deliveries have no notificationId. A generic object ID is not a delivery ID.
// Missing IDs must stay omitted so Store uses its rolling five-minute body-hash window.
export function extractApidogDeliveryId(_raw: Uint8Array, parsed: unknown, _now: number): string | undefined {
  const id = string(object(parsed).notificationId).trim();
  return id || undefined;
}
export function apidogEvent(parsed: unknown): string {
  return string(object(parsed).event).trim() || 'notification';
}

export function formatApidog(delivery: Delivery, config: FormatConfig): OutgoingMessage[] {
  if (delivery.source !== 'apidog') return [];
  const payload = object(JSON.parse(new TextDecoder().decode(delivery.raw)));
  const event = escapeHtml(truncate(delivery.event || 'notification', 180));
  const title = escapeHtml(truncate(string(payload.title), 240));
  const content = escapeHtml(truncate(string(payload.content), 2000));
  const url = safeUrl(string(payload.appLink));
  const html = fitHtml([`<b>Apidog</b> · ${event}`, title, content].filter(Boolean).join('\n'));
  return [{ topic: config.apidogTopic, html, ...(url ? { button: { text: 'Открыть в Apidog', url } } : {}) }];
}

export function formatApidogMr(delivery: Delivery, config: FormatConfig & ApidogMergeConfig): OutgoingMessage[] {
  if (delivery.source !== 'apidog' || !['MR_OPENED', 'MR_CLOSED', 'MR_MERGED'].includes(delivery.event)
    || !delivery.deliveryId?.startsWith('mr-poll:')) return [];
  const mr = object(JSON.parse(new TextDecoder().decode(delivery.raw)));
  const validId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  if (!validId(mr.id) || !validId(mr.createdById) || mr.targetBranchId !== config.targetBranchId
    || typeof mr.description !== 'string' || delivery.deliveryId !== `mr-poll:${mr.id}:${delivery.event.slice(3)}`
    || (delivery.event !== 'MR_OPENED' && mr.closedById !== null && !validId(mr.closedById))) return [];
  const seen = new Set<string>();
  const person = (id: number): string => {
    const entry = Object.hasOwn(config.peopleMap, String(id)) ? config.peopleMap[String(id)] : undefined;
    if (!entry) return `Apidog user ${id}`;
    const name = truncate(entry.name, 100);
    const html = mention(name, seen.has(entry.telegramId) ? {} : { [name]: entry.telegramId });
    seen.add(entry.telegramId);
    return html;
  };
  const action = delivery.event === 'MR_OPENED' ? 'Открыт' : delivery.event === 'MR_CLOSED' ? 'Закрыт' : 'Слит';
  const roles = [`Создатель MR: ${person(mr.createdById)}`];
  if (delivery.event !== 'MR_OPENED' && validId(mr.closedById)) roles.push(`${delivery.event === 'MR_CLOSED' ? 'Закрыл' : 'Слил'} MR: ${person(mr.closedById)}`);
  const footer = roles.join('\n');
  const summary = `<b>Apidog</b> · ${action} MR #${mr.id}\n${escapeHtml(truncate(mr.description, 2000))}`;
  return [{ topic: config.apidogTopic, html: `${fitHtml(summary, 4094 - footer.length)}\n${footer}`,
    button: { text: 'Открыть MR', url: `https://app.apidog.com/project/${config.projectId}/branch/${config.targetBranchId}/merge-request/${mr.id}` },
    secondaryButton: { text: 'Контракт API', url: config.contractUrl } }];
}
