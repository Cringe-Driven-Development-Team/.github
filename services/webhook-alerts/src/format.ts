export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export function truncate(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length > limit ? chars.slice(0, Math.max(0, limit - 1)).join('') + '…' : text;
}
export function safeUrl(text: string): string | undefined {
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || text.length > 1500) return;
    return url.href.replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E');
  } catch { return; }
}
export function link(text: string, url: string): string {
  const safe = safeUrl(url);
  return safe ? `<a href="${escapeHtml(safe)}">${text}</a>` : text;
}
export function mention(login: string, map: Record<string, string | number> = {}): string {
  const text = escapeHtml(truncate(login, 80));
  const id = Object.hasOwn(map, login) ? String(map[login]) : '';
  return /^[1-9]\d{0,19}$/.test(id) ? `<a href="tg://user?id=${id}">${text}</a>` : text;
}

// GitHub Markdown's useful subset. Code spans/fences are protected from all substitutions.
export function quoteMarkdown(text: string, limit = 700): string {
  const code = /```[\s\S]*?```|`[^`\n]+`/g;
  const protectedParts: string[] = [];
  const protect = (value: string) => `\u0000${protectedParts.push(value) - 1}\u0000`;
  text = text.replace(/\r/g, '').replace(/\u0000/g, '').replace(code, protect)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<img\b[^>]*?\bsrc="([^"]+)"[^>]*>/gi, '[🖼 картинка]($1)')
    .replace(/!\[[^\]\n]*\]\(([^)\s]+)[^)\n]*\)/g, '[🖼 картинка]($1)')
    .replace(/<br\s*\/?>|<\/(?:p|div|summary|details|li|tr|h\d)>/gi, '\n')
    .replace(/<(https?:\/\/[^<>\s]+)>/g, '[$1]($1)')
    .replace(/<([^<>\s@]+@[^<>\s]+)>/g, '$1')
    .replace(/<\/?[A-Za-z][^<>\n]*>/g, '')
    .replace(/\u0000(\d+)\u0000/g, (_, n) => protectedParts[Number(n)] ?? '')
    .replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  text = truncate(text, limit);
  // A fence truncated by the budget becomes ordinary text, never an unterminated tag.
  if ((text.match(/^```/gm)?.length ?? 0) % 2) text = text.replace(/^```[^\n]*\n?/m, '');
  protectedParts.length = 0;
  text = text.replace(/```[^\n]*\n([\s\S]*?)\n?```|`([^`\n]+)`/g, (_, block, inline) =>
    protect(block !== undefined ? `<pre>${escapeHtml(block)}</pre>` : `<code>${escapeHtml(inline)}</code>`));
  text = escapeHtml(text)
    .replace(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm, (_, heading: string) => protect(`<b>${heading.replace(/\*\*/g, '')}</b>`))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label: string, url: string) =>
      protect(link(label, url.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))))
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<b>$1</b>')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<s>$1</s>')
    .replace(/^([ \t]*)[-*+]\s+\[ \]\s+/gm, '$1☐ ')
    .replace(/^([ \t]*)[-*+]\s+\[[xX]\]\s+/gm, '$1☑ ')
    .replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ')
    .replace(/\u0000(\d+)\u0000/g, (_, n) => protectedParts[Number(n)] ?? '');
  return text.replace(/\u0000(\d+)\u0000/g, (_, n) => protectedParts[Number(n)] ?? '');
}
export function plural(n: number, one: string, few: string, many: string): string {
  return `${n} ${n % 100 >= 11 && n % 100 <= 14 ? many : n % 10 === 1 ? one : n % 10 >= 2 && n % 10 <= 4 ? few : many}`;
}
export const commitsLabel = (n: number) => plural(n, 'коммит', 'коммита', 'коммитов');

// Input is generated HTML only. Keep entities/tags whole and reserve room for closing tags.
export function fitHtml(html: string, limit = 4095): string {
  if (html.length <= limit) return html;
  const closing: string[] = [];
  let result = '';
  for (const token of html.matchAll(/<[^>]*>|&(?:amp|lt|gt|quot);|[\s\S]/gu)) {
    const part = token[0];
    const next = [...closing];
    const open = part.match(/^<([a-z]+)(?:\s[^>]*)?>$/);
    if (open) next.unshift(`</${open[1]}>`);
    else if (part.startsWith('</')) next.shift();
    if (result.length + part.length + next.join('').length + 1 > limit) break;
    result += part;
    closing.splice(0, closing.length, ...next);
  }
  return result + '…' + closing.join('');
}
