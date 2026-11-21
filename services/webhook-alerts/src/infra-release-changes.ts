import type { ChangeReport } from './release-api';

export interface InfraReleaseChanges {
  base: string;
  head: string;
  compareUrl: string;
  entries: { kind: 'issue' | 'pr'; title: string; url: string }[];
}

export function publisherPath(service: 'githubbot' | 'webhook-alerts', path: string): boolean {
  const workflow = service === 'githubbot' ? 'githubbot' : 'webhook';
  return path.startsWith('services/' + service + '/') || [
    `.github/workflows/${service}-image.yml`,
    `tests/${workflow}-workflows.test.ts`,
    `tests/${service}-docker.sh`,
    '.github/workflows/checks.yml',
    'services/webhook-alerts/src/format.ts',
    'scripts/auxiliary-publish.sh',
    'tests/auxiliary-publish.test.ts',
    '.dockerignore',
  ].includes(path);
}

export function releaseEntries(report: ChangeReport): InfraReleaseChanges['entries'] {
  const entries: InfraReleaseChanges['entries'] = [];
  const linked = new Set<number>();
  for (const issue of report.issues) {
    issue.prNumbers.forEach(pr => linked.add(pr));
    const repo = issue.repo.split('/').map(encodeURIComponent).join('/');
    entries.push({ kind: 'issue', title: issue.title, url: `https://github.com/${repo}/issues/${issue.number}` });
  }
  for (const pr of report.prs) {
    if (!linked.has(pr.number)) entries.push({ kind: 'pr', title: pr.title, url: pr.url });
  }
  return entries;
}
