export function parseApidogBranchNotice(payload: unknown, config: {
  event: 'BRANCH_CREATED' | 'BRANCH_MERGED'; projectName: string; branchField: string; timeField: string;
}): { branchName: string; atIso: string } | undefined {
  if (!payload || typeof payload !== 'object') return;
  const body = payload as Record<string, unknown>;
  if (body.event !== config.event || typeof body.content !== 'string') return;
  const lines = body.content.split(/\r?\n/);
  const field = (label: string): string | undefined => {
    const values = lines.filter(line => line.startsWith(`${label}:`));
    return values.length === 1 ? values[0]!.slice(label.length + 1).trim() || undefined : undefined;
  };
  const branchName = field(config.branchField);
  const date = field(config.timeField);
  if (!branchName || field('Project') !== config.projectName || !date || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date)) return;
  const atIso = date.replace(' ', 'T') + '.000Z';
  const parsed = new Date(atIso);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== atIso) return;
  return { branchName, atIso };
}
