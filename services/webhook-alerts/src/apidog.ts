import type { Delivery, OutgoingMessage } from './store';
import { escapeHtml, fitHtml, link, safeUrl, truncate } from './format';

export interface FormatConfig { apidogTopic: number }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';

// Provisional synthetic payload contract. A generic object ID is not a delivery ID.
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
  const item = object(payload.object);
  const event = escapeHtml(truncate(delivery.event || 'notification', 180));
  const name = escapeHtml(truncate(string(item.name), 240));
  const url = safeUrl(string(item.url));
  const html = fitHtml([`<b>Apidog</b> · ${event}`, name ? link(name, url ?? '') : ''].filter(Boolean).join('\n'));
  return [{ topic: config.apidogTopic, html, ...(url ? { button: { text: 'Открыть в Apidog', url } } : {}) }];
}
