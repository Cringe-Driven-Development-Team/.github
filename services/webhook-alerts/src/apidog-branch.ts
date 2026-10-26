import type { ApidogApi } from './apidog-api';
import type { Delivery, OutgoingMessage } from './store';
import { parseApidogBranchNotice } from './apidog-notice';

export function parseCreatedBranchNotice(payload: unknown, projectName: string): { branchName: string; createdAtIso: string } | undefined {
  const notice = parseApidogBranchNotice(payload, { event: 'BRANCH_CREATED', projectName, branchField: 'SprintBranch', timeField: 'Created at' });
  return notice ? { branchName: notice.branchName, createdAtIso: notice.atIso } : undefined;
}

export async function formatApidogBranchCreated(delivery: Delivery, base: OutgoingMessage, api: Pick<ApidogApi, 'findCreatedBranch'>, config: { projectId: number; projectName: string }): Promise<OutgoingMessage> {
  if (delivery.source !== 'apidog' || delivery.event !== 'BRANCH_CREATED') return base;
  const notice = parseCreatedBranchNotice(JSON.parse(new TextDecoder().decode(delivery.raw)), config.projectName);
  if (!notice) return base;
  try {
    const branch = await api.findCreatedBranch({ projectId: config.projectId, ...notice });
    return branch && Number.isSafeInteger(branch.id) && branch.id > 0
      ? { ...base, button: { text: 'Открыть ветку', url: `https://app.apidog.com/project/${config.projectId}/branch/${branch.id}` } }
      : base;
  } catch {
    console.error(JSON.stringify({ errorCode: 'apidog_branch_lookup_failed' }));
    return base;
  }
}
