import type { Delivery, OutgoingMessage } from './store';
import { escapeHtml, fitHtml, safeUrl, truncate } from './format';

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
