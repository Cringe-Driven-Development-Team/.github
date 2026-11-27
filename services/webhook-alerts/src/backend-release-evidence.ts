import { unzipSync } from 'fflate';
import { GithubApiError } from './github-api';

export const SERVICES = ['identity', 'workspace', 'environments'] as const;
export const SERVICE_NAMES = { identity: 'Identity', workspace: 'Workspace', environments: 'Environments' };
export type Service = (typeof SERVICES)[number];
export type ServiceVersion = {
  image_ref: string;
  source_sha: string;
  protocol_revision: string;
  migration_version: number;
};
export type ServiceInventory = Partial<Record<Service, ServiceVersion>>;
type CheckState = 'passed' | 'failed' | 'unknown';
export type ServiceChecks = { image: CheckState; ready: CheckState; smoke: CheckState };
export interface BackendDeployment {
  releaseTag: string;
  infraSha: string;
  selected: Service[];
  before: ServiceInventory;
  desired: ServiceInventory;
  result?: { observed: ServiceInventory; checks: Partial<Record<Service, ServiceChecks>> };
}
export const RESULT_NAME = 'deployment-result.json';
export const MAX_RESULT_ZIP = 128 * 1024;
const MAX_RESULT_JSON = 64 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const IMAGE_ROOT = 'ghcr.io/cringe-driven-development-team';
export const SERVICE_ARCHIVES = SERVICES.map(service => `${service}-image.tar.gz`);

function fail(code: string): never {
  throw new GithubApiError(`untrusted_backend_${code}`);
}
function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}
function knownService(key: string): key is Service {
  return SERVICES.some(service => service === key);
}
function sourceSha(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SHA.test(value)) fail(code);
  return value;
}
function serviceVersion(value: unknown, service: Service, code: string, releaseProtocol?: string): ServiceVersion {
  const raw = object(value, code);
  const prefix = `${IMAGE_ROOT}/cellestial-${service}@`;
  if (typeof raw.image_ref !== 'string' || !raw.image_ref.startsWith(prefix) || !IMAGE_ID.test(raw.image_ref.slice(prefix.length))
      || typeof raw.migration_version !== 'number' || !Number.isSafeInteger(raw.migration_version) || raw.migration_version < 1)
    fail(code);
  const protocol = sourceSha(raw.protocol_revision ?? releaseProtocol, code);
  if (releaseProtocol !== undefined && protocol !== releaseProtocol) fail(code);
  return {
    image_ref: raw.image_ref, source_sha: sourceSha(raw.source_sha, code),
    protocol_revision: protocol, migration_version: raw.migration_version,
  };
}
function inventory(value: unknown, code: string, releaseProtocol?: string): ServiceInventory {
  const versions: ServiceInventory = {};
  for (const [key, row] of Object.entries(object(value, code))) {
    if (!knownService(key)) fail(code);
    versions[key] = serviceVersion(row, key, code, releaseProtocol);
  }
  return versions;
}
export function sameVersion(a: ServiceVersion | undefined, b: ServiceVersion | undefined): boolean {
  return a?.image_ref === b?.image_ref && a?.source_sha === b?.source_sha
    && a?.protocol_revision === b?.protocol_revision && a?.migration_version === b?.migration_version;
}
function checkedSelection(raw: unknown, code: string): Service[] {
  if (!Array.isArray(raw) || !raw.length || raw.some(key => typeof key !== 'string' || !knownService(key))
      || new Set(raw).size !== raw.length) fail(code);
  return SERVICES.filter(service => raw.includes(service));
}

export function readBackendDeployment(
  payload: Record<string, unknown>, target: string, action: 'deploy' | 'rollback',
): BackendDeployment {
  const code = 'deployment';
  const desired = inventory(payload.desired, code), before = inventory(payload.before, code),
    selected = checkedSelection(payload.selected_services, code), infraSha = sourceSha(payload.infra_sha, code);
  const releaseTag = `release-${target}`;
  if (payload.release_tag !== releaseTag) fail(code);
  for (const service of SERVICES) {
    const version = desired[service];
    if (!version || (selected.includes(service)
      ? action === 'deploy' && version.source_sha !== target : !sameVersion(before[service], version))) fail(code);
  }
  return { releaseTag, infraSha, selected, before, desired };
}

interface ArchiveAsset { size: number; digest: string }
export function readBackendManifest(
  value: unknown, target: string, assets: ReadonlyMap<string, ArchiveAsset>,
): { versions: ServiceInventory; ciUrl: string } {
  const code = 'manifest', manifest = object(value, code);
  if (manifest.format_version !== 2 || manifest.source_sha !== target || typeof manifest.ci_url !== 'string') fail(code);
  const protocol = sourceSha(manifest.protocol_revision, code),
    services = object(manifest.services, code), versions = inventory(services, code, protocol);
  for (const service of SERVICES) {
    const row = object(services[service], code), archive = object(row.archive, code);
    const name = `${service}-image.tar.gz`, asset = assets.get(name);
    if (row.source_sha !== target || row.platform !== 'linux/amd64'
        || typeof row.image_id !== 'string' || !IMAGE_ID.test(row.image_id)
        || !asset || archive.name !== name || archive.size !== asset.size || archive.sha256 !== asset.digest) fail(code);
    if (service === 'environments') {
      const kernel = `${IMAGE_ROOT}/cellestial-kernel-python@`;
      if (row.agent_version !== target || typeof row.kernel_ref !== 'string'
          || !row.kernel_ref.startsWith(kernel) || !IMAGE_ID.test(row.kernel_ref.slice(kernel.length))) fail(code);
    }
  }
  return { versions, ciUrl: manifest.ci_url };
}

export function readResultArchive(bytes: Uint8Array): unknown {
  try {
    let filesSeen = 0;
    const files = unzipSync(bytes, {
      filter(file) {
        filesSeen++;
        if (file.name !== RESULT_NAME || file.originalSize > MAX_RESULT_JSON || file.size > MAX_RESULT_ZIP)
          fail('result_archive');
        return true;
      },
    });
    const result = files[RESULT_NAME];
    if (filesSeen !== 1 || !result?.byteLength) fail('result_archive');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result));
  } catch {
    fail('result_archive');
  }
}

function checkState(value: unknown): CheckState {
  if (value !== 'passed' && value !== 'failed' && value !== 'unknown') fail('result_checks');
  return value;
}
export function servicePassed(checks: ServiceChecks | undefined): boolean {
  return checks?.image === 'passed' && checks.ready === 'passed' && checks.smoke === 'passed';
}
export function readBackendResult(value: unknown, operation: BackendDeployment, identity: {
  id: number; sha: string; kind: 'deploy' | 'rollback'; runId: number; attempt: number; success: boolean;
}): NonNullable<BackendDeployment['result']> {
  const code = 'result', report = object(value, code);
  if (report.schema_version !== 2 || report.run_id !== identity.runId || report.run_attempt !== identity.attempt
      || report.source_sha !== identity.sha || report.action !== identity.kind || report.deployment_id !== identity.id
      || report.release_tag !== operation.releaseTag || report.infra_sha !== operation.infraSha)
    fail(code);
  const selection = checkedSelection(report.selected_services, code);
  const before = inventory(report.before, code), desired = inventory(report.desired, code);
  if (selection.join() !== operation.selected.join() || SERVICES.some(service =>
    !sameVersion(before[service], operation.before[service]) || !sameVersion(desired[service], operation.desired[service])))
    fail(code);
  const observed = inventory(report.observed, code), checks: Partial<Record<Service, ServiceChecks>> = {};
  const rawChecks = object(report.checks, 'result_checks');
  if (Object.keys(rawChecks).length !== selection.length) fail('result_checks');
  for (const service of selection) {
    const row = object(rawChecks[service], 'result_checks');
    const facts = { image: checkState(row.image), ready: checkState(row.ready), smoke: checkState(row.smoke) };
    const correctImage = sameVersion(observed[service], desired[service]);
    if ((facts.image === 'passed' && !correctImage) || (identity.success && !servicePassed(facts))) fail('result_checks');
    checks[service] = facts;
  }
  if (identity.success && SERVICES.some(service => !sameVersion(observed[service], desired[service]))) fail('result_checks');
  return { observed, checks };
}
