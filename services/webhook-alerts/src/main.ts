import { BACKEND_REPO } from './backend-releases';
import {createReleaseApi} from './release-api';
import {projectRelease,checkReleaseNotice} from './releases';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, type Config } from './config';
import { createApp, MAX_BODY_BYTES } from './http';
import { createGithubApi } from './github-api';
import { openStore } from './store';
import { sendMessage } from './telegram';
import { createGithubProjector, startWorker } from './worker';

export function startService(config: Config, options: { fetch?: typeof fetch } = {}) {
  // Validate before opening storage even when called directly rather than through loadConfig.
  if (config.sendEnabled && !config.telegram) throw new Error('Telegram sender configuration is required');
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const store = openStore(config.databasePath);
  if (store.releaseActivation() !== null && (!config.releasesTopic || !config.githubApiToken?.trim())) {store.close();throw new Error('release notifications require topic and API token');}
  if (store.releaseActivation(BACKEND_REPO) !== null && (!config.backendReleasesTopic || !config.githubApiToken?.trim())) {store.close();throw new Error('backend release notifications require topic and API token');}
  const controller = new AbortController();
  const app = createApp({ config, checkDb: () => store.checkHealth(), accept: delivery => store.accept(delivery) });
  const fetcher = options.fetch ?? fetch;
  const releaseApi=createReleaseApi({token:config.githubApiToken,fetch:fetcher});
  const backendReleaseApi=createReleaseApi({token:config.githubApiToken,fetch:fetcher,repository:BACKEND_REPO});
  const worker = config.sendEnabled ? startWorker({
    store,
    ...((config.releasesTopic === undefined && config.backendReleasesTopic === undefined) ? {} : {
      releaseProject: (delivery: import('./store').Delivery) => {
        const repository = JSON.parse(new TextDecoder().decode(delivery.raw)).repository?.full_name;
        const backend = repository === BACKEND_REPO;
        const topic = backend ? config.backendReleasesTopic : config.releasesTopic;
        if (topic === undefined) return Promise.resolve([]);
        return projectRelease(delivery, backend ? backendReleaseApi : releaseApi, {
          topic, siteUrl:'https://cellestial.ru', userMap:config.userMap, repository,
          cutoffMs:store.releaseActivation(repository) ?? Infinity,
          releaseCutoffMs:store.releaseContract() ?? Infinity,
        });
      },
      beforeReleaseSend: (notice: import('./store').ReleaseNotice) => checkReleaseNotice(notice, notice.repository === BACKEND_REPO ? backendReleaseApi : releaseApi, notice.repository === BACKEND_REPO ? {topic:config.backendReleasesTopic!,siteUrl:'https://cellestial.ru',userMap:config.userMap,repository:BACKEND_REPO} : undefined),
    }),
    project: createGithubProjector(createGithubApi({ token: config.githubApiToken, fetch: (url, init) => fetcher(url, init) }), {
      githubTopic: config.githubTopic, reviewTopic: config.reviewTopic, userMap: config.userMap,
    }),
    send: message => sendMessage(message, config.telegram!, fetcher),
    signal: controller.signal,
  }) : Promise.resolve();
  let stopping: Promise<void> | undefined;
  return { app, stop: () => stopping ??= (async () => { controller.abort(); await worker; store.close(); })() };
}

if (import.meta.main) {
  const config = loadConfig(Bun.env);
  const service = startService(config);
  let server: ReturnType<typeof Bun.serve>;
  try { server = Bun.serve({ port: config.port, hostname: '0.0.0.0', fetch: service.app.fetch, maxRequestBodySize: MAX_BODY_BYTES }); }
  catch (error) { await service.stop(); throw error; }
  const shutdown = async () => { await server.stop(); await service.stop(); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
