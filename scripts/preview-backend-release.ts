// Local synthetic cards; this script never calls GitHub or Telegram.
import { mkdirSync } from 'node:fs';
import { projectRelease } from '../services/webhook-alerts/src/releases';
import { delivery, releaseFixture } from '../services/webhook-alerts/tests/helpers/release';

const repository = 'Cringe-Driven-Development-Team/backend';
const outputPath = 'docs/superpowers/previews/github-59-backend-cards.html';
const cards: string[] = [];

for (const kind of ['success', 'health-failure', 'rollback', 'preflight-refusal']) {
  const fixture = releaseFixture();
  fixture.operation.run.workflow = 'CI';
  fixture.operation.run.event = 'push';
  fixture.operation.run.url = `https://github.com/${repository}/actions/runs/10`;
  fixture.operation.notification.report_url = `${fixture.operation.run.url}#summary`;
  fixture.operation.imageRef = `ghcr.io/cringe-driven-development-team/backend@sha256:${'d'.repeat(64)}`;
  fixture.operation.run.steps = [
    { name: 'Switch backend', outcome: 'success' },
    { name: 'Health check', outcome: 'success' },
  ];
  fixture.report.issues[0]!.repo = repository;
  fixture.report.issues[0]!.title = 'Backend. Проверить доступность Go API';
  fixture.report.prs[0]!.url = `https://github.com/${repository}/pull/42`;

  if (kind === 'health-failure') {
    fixture.operation.state = 'failure';
    fixture.operation.run.steps[1]!.outcome = 'failure';
  }
  if (kind === 'rollback') fixture.operation.kind = 'rollback';

  let event = delivery('deployment_status', {
    repository: { full_name: repository },
    action: 'created',
    deployment: { id: 1, environment: 'production' },
    deployment_status: { state: 'success' },
  });
  if (kind === 'preflight-refusal') {
    fixture.job.run.steps = [
      { name: 'Prepare target', outcome: 'failure' },
      { name: 'Switch backend', outcome: 'skipped' },
      { name: 'Health check', outcome: 'skipped' },
    ];
    event = delivery('workflow_job', {
      repository: { full_name: repository },
      action: 'completed',
      workflow_job: { id: 100, name: 'deploy / deploy', conclusion: 'failure' },
    });
  }

  const [card] = await projectRelease(event, fixture.api, {
    topic: 3377,
    siteUrl: 'https://cellestial.ru',
    repository,
  });
  if (!card) throw new Error('Missing preview');

  const content = card.html.split('\n').join('<br>\n          ');
  const keyboard = (card.keyboard ?? []).map(row => [
    '        <nav>',
    ...row.map(button => `          <a href="${button.url}">${button.text}</a>`),
    '        </nav>',
  ].join('\n')).join('\n');

  cards.push(`      <article>
        <small>Синтетический пример · ${kind}</small>
        <div>
          ${content}
        </div>
${keyboard}
      </article>`);
}

const html = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Backend release cards · local preview</title>
    <style>
      body {
        font: 16px system-ui;
        background: #dfe8ee;
        color: #172b3a;
        margin: 32px;
      }

      main {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
        gap: 24px;
      }

      article {
        background: white;
        border-radius: 16px;
        padding: 24px;
        line-height: 1.6;
        overflow-wrap: anywhere;
      }

      small {
        color: #657a89;
        display: block;
        margin-bottom: 20px;
      }

      nav {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }

      nav a {
        flex: 1;
        background: #e4f0f8;
        text-align: center;
        border-radius: 6px;
        padding: 8px;
        text-decoration: none;
      }

      a {
        color: #146596;
      }

      code {
        font-size: 12px;
      }

      h1 {
        font-size: 24px;
      }
    </style>
  </head>
  <body>
    <h1>Backend / Releases — локальные примеры</h1>
    <p>Это HTML-превью; реальные сообщения не отправлялись.</p>
    <main>
${cards.join('\n\n')}
    </main>
  </body>
</html>
`;

mkdirSync('docs/superpowers/previews', { recursive: true });
await Bun.write(outputPath, html);
console.info(outputPath);
