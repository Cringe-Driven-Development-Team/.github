import {createReleaseApi} from './release-api';
import {projectRelease,checkReleaseNotice} from './releases';
import { createApidogApi } from './apidog-api';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, type Config } from './config';
import { createApp, MAX_BODY_BYTES } from './http';
import { createGithubApi } from './github-api';
import { openStore } from './store';
import { sendMessage } from './telegram';
import { createProjector, startWorker } from './worker';

export function startService(config: Config, options: { fetch?: typeof fetch } = {}) {
  // Validate before opening storage even when called directly rather than through loadConfig.
  if (config.sendEnabled && (!config.telegram || !config.apidogTelegram || config.apidogTopic === undefined)) throw new Error('Telegram sender configuration is required');
  if (config.sendEnabled && (!config.apidogMerge || !config.apidogAccessToken?.trim())) throw new Error('Apidog merge configuration is required');
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const store = openStore(config.databasePath);
  if (store.releaseActivation() !== null && (!config.releasesTopic || !config.githubApiToken?.trim())) {store.close();throw new Error('release notifications require topic and API token');}
  const controller = new AbortController();
  const app = createApp({ config, checkDb: () => store.checkHealth(), accept: delivery => store.accept(delivery) });
  const fetcher = options.fetch ?? fetch;
  const releaseApi=createReleaseApi({token:config.githubApiToken,fetch:fetcher});
  const apidogApi = config.sendEnabled ? createApidogApi({ token: config.apidogAccessToken!, fetch: fetcher }) : undefined;
  if (config.sendEnabled) store.startApidogMrMonitoring(Date.now());
  const worker = config.sendEnabled ? startWorker({
    store,
    ...(config.releasesTopic===undefined?{}:{
      releaseProject:(delivery:import('./store').Delivery)=>projectRelease(delivery,releaseApi,{topic:config.releasesTopic!,siteUrl:'https://cellestial.ru',userMap:config.userMap,cutoffMs:store.releaseActivation()??Infinity}),
      beforeReleaseSend:(notice:import('./store').ReleaseNotice)=>checkReleaseNotice(notice,releaseApi),
    }),
    project: createProjector(createGithubApi({ token: config.githubApiToken, fetch: (url, init) => fetcher(url, init) }), {
      githubTopic: config.githubTopic, reviewTopic: config.reviewTopic, userMap: config.userMap, apidogTopic: config.apidogTopic!,
    }, { api: apidogApi!, config: config.apidogMerge! }),
    send: message => sendMessage(message, message.source === 'apidog' ? config.apidogTelegram! : config.telegram!, fetcher),
    signal: controller.signal,
    pollApidog: async () => {
      const rows = await apidogApi!.listMergeRequests(config.apidogMerge!);
      if (!controller.signal.aborted) store.recordApidogMergeRequests(rows);
    },
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
