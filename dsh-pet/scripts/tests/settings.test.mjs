// Real React + Chromium; API fixtures never touch the user's DSH configuration.
// First run: pnpm exec playwright install chromium
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { rolldown } from 'rolldown';

const pet = {
  id: 'pet-1',
  name: 'Blue',
  size: 240,
  display: 'web',
  position: { corner: 'top-right', marginX: 20, marginY: 20 },
};
const defaults = {
  main: {
    pets: [pet],
    notificationsEnabled: true,
    emotionEnabled: true,
    doNotDisturb: false,
    whisperImageEnabled: false,
    chatImageEnabled: false,
    confineToScreen: false,
    physics: {
      gravity: 2400,
      restitution: 0.6,
      groundFriction: 4,
      throwPower: 1,
      ceilingBounce: false,
      petCollision: false,
    },
    whisperModel: { provider: '', model: '' },
    chatModel: { provider: '', model: '' },
    chatMemoryRounds: 5,
    chatImageLimit: 10,
  },
};
const customized = {
  main: {
    ...defaults.main,
    notificationsEnabled: false,
    emotionEnabled: false,
    doNotDisturb: true,
    whisperImageEnabled: true,
    chatImageEnabled: true,
    confineToScreen: true,
    chatMemoryRounds: 19,
    chatImageLimit: 2,
    whisperModel: { provider: 'test', model: 'model' },
    chatModel: { provider: 'test', model: 'model' },
    physics: { ...defaults.main.physics, gravity: 1200, throwPower: 2, ceilingBounce: true, petCollision: true },
  },
};
const emotionReport = {
  ok: true,
  enabled: true,
  doNotDisturb: false,
  state: { valence: 0.28, arousal: 0.47, label: 'cheerful', updatedAt: 1800000000000 },
  build: { id: 'emotion-mvp1.1-20261023.1', version: '0.3.7-emotion.1.1' },
  diagnostics: {
    capacity: 80,
    lifetime: 'process',
    records: [
      {
        seq: 1,
        ts: 1800000000000,
        category: 'event',
        event: 'praise',
        accepted: true,
        reason: 'accepted',
        before: { valence: 0, arousal: 0.35, label: 'calm' },
        after: { valence: 0.28, arousal: 0.47, label: 'cheerful' },
        strategy: 'warm-chat',
        animation: '开心转圈',
      },
      {
        seq: 2,
        ts: 1800000000001,
        category: 'proactive',
        event: 'automatic-whisper',
        accepted: false,
        reason: 'cooldown',
        strategy: 'quiet-companion',
        animation: null,
      },
    ],
  },
};
let browser, server, url;
before(async () => {
  const bundle = await rolldown({
    input: fileURLToPath(new URL('./settings.fixture.js', import.meta.url)),
    platform: 'browser',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  });
  const { output } = await bundle.generate({ format: 'iife' });
  await bundle.close();
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(output[0].code);
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      `<html><head><style>:root{--dsw-alias-bg-layer-1:#fff;--dsw-alias-label-primary:#202020;--dsw-alias-label-secondary:#444;--dsw-alias-label-tertiary:#666;--dsw-alias-border-l2:#bbb;--dsw-alias-state-business-primary:#245eea;--dsw-alias-button-info-fill:#245eea;--dsw-alias-state-error-primary:#c22}body{margin:16px;font-family:sans-serif}</style></head><body><div id="root"></div><script>window.initialConfig=${JSON.stringify(defaults)};</script><script src="/fixture.js"></script></body></html>`,
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  const channel = process.env.DSH_PET_TEST_BROWSER_CHANNEL;
  browser = await chromium.launch(channel ? { channel } : undefined);
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function open(
  t,
  { get = customized, viewport = { width: 900, height: 900 }, lang = 'en', diagnostics = emotionReport } = {},
) {
  const context = await browser.newContext({ viewport });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const writes = [],
    resets = [],
    diagnosticReads = [],
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('**/dsh-pet-7340/**', async (route) => {
    const request = route.request();
    if (new URL(request.url()).pathname === '/dsh-pet-7340/emotion/reset') {
      resets.push({ method: request.method(), url: request.url() });
      return route.fulfill({ json: { ok: true } });
    }
    if (new URL(request.url()).pathname === '/dsh-pet-7340/emotion') {
      diagnosticReads.push({ method: request.method(), url: request.url(), headers: request.headers() });
      if (typeof diagnostics === 'function') return diagnostics(route);
      return route.fulfill({ json: diagnostics });
    }
    if (new URL(request.url()).pathname === '/dsh-pet-7340/config') {
      if (request.method() === 'PUT') {
        writes.push(request.postDataJSON());
        return route.fulfill({ json: customized });
      }
      if (request.method() === 'POST') return route.fulfill({ json: defaults });
      if (typeof get === 'function') return get(route);
      return route.fulfill({ json: get });
    }
    if (request.url().endsWith('/config/meta')) {
      return route.fulfill({
        json: {
          user: '/test/main-config.jsonc',
          default: '/test/assets/config.jsonc',
          animations: '/test/main-animation',
        },
      });
    }
    return route.fulfill({
      json: { providers: [{ id: 'test', name: 'Test', models: [{ id: 'model', name: 'Model' }] }] },
    });
  });
  await page.goto(`${url}/?lang=${lang}`);
  await page.locator('.dsh-pet-cfg').waitFor();
  return { page, writes, resets, diagnosticReads };
}

async function save(page) {
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'PUT'),
    page.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
}

test('pending config prevents editing and saving placeholder defaults', async (t) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { page, writes } = await open(t, {
    get: async (route) => {
      await pending;
      await route.fulfill({ json: customized });
    },
  });
  try {
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('input[type=text]').first().isDisabled(), true);
    assert.deepEqual(writes, []);
  } finally {
    release();
  }
});

for (const failure of ['http', 'network', 'malformed', 'null']) {
  test(`failed config (${failure}) is visible, blocks Save and can be retried`, async (t) => {
    let fail = true;
    const { page, writes } = await open(t, {
      get: (route) =>
        !fail
          ? route.fulfill({ json: customized })
          : failure === 'network'
            ? route.abort()
            : route.fulfill(
                failure === 'http' ? { status: 503, body: 'unavailable' } : { json: failure === 'null' ? null : {} },
              ),
    });
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
    assert.deepEqual(writes, []);
    fail = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await save(page);
    assert.equal(writes.length, 1);
    for (const [key, value] of Object.entries(customized.main)) assert.deepEqual(writes[0][key], value, key);
  });
}

test('Sync updates all controls so a subsequent Save preserves the restored defaults', async (t) => {
  const { page, writes } = await open(t);
  await save(page);
  assert.equal(writes[0].chatMemoryRounds, 19);
  await page.getByRole('button', { name: 'Sync', exact: true }).click();
  await page.getByRole('button', { name: 'Sync', exact: true }).last().click();
  await save(page);
  assert.equal(writes.length, 2);
  for (const [key, value] of Object.entries(defaults.main)) assert.deepEqual(writes[1][key], value, key);
});

test('fresh config refreshes the pet list instead of saving an old bridge snapshot', async (t) => {
  const fresh = { main: { ...customized.main, pets: [{ ...pet, name: 'Updated elsewhere', size: 360 }] } };
  const { page, writes } = await open(t, { get: fresh });
  await save(page);
  assert.deepEqual(writes[0].pets, fresh.main.pets);
});

test('emotion and do-not-disturb controls save global flags, and reset uses its own action', async (t) => {
  const { page, writes, resets } = await open(t);
  const emotion = page.getByRole('checkbox', { name: 'Continuous emotions', exact: true });
  const quiet = page.getByRole('checkbox', { name: 'Do not disturb', exact: true });
  assert.equal(await emotion.isChecked(), false);
  assert.equal(await quiet.isChecked(), true);
  await emotion.check();
  await quiet.uncheck();
  await save(page);
  assert.equal(writes[0].emotionEnabled, true);
  assert.equal(writes[0].doNotDisturb, false);
  await page.getByRole('button', { name: 'Reset all pet emotions', exact: true }).click();
  await page.getByText('All pet emotions reset.', { exact: true }).waitFor();
  assert.equal(resets.length, 1);
  assert.equal(resets[0].method, 'POST');
  assert.equal(new URL(resets[0].url).search, '');
  assert.equal(writes.length, 1, 'reset does not overwrite configuration');
});

test('diagnostics load only on demand, refresh and pet selection without writes or polling', async (t) => {
  const config = { main: { ...customized.main, pets: [pet, { ...pet, id: 'pet-2', name: 'Green' }] } };
  const { page, writes, resets, diagnosticReads } = await open(t, { get: config });
  await page.getByRole('button', { name: 'Save', exact: true }).waitFor({ state: 'visible' });
  assert.equal(diagnosticReads.length, 0);
  await page.getByRole('button', { name: 'Show local emotion diagnostics', exact: true }).click();
  const section = page.getByRole('region', { name: 'Local emotion diagnostics', exact: true });
  await section.getByText('Local build：emotion-mvp1.1-20261023.1 / 0.3.7-emotion.1.1', { exact: true }).waitFor();
  assert.equal(diagnosticReads.length, 1);
  assert.equal(diagnosticReads[0].method, 'GET');
  assert.equal(diagnosticReads[0].headers['x-dsh-pet-diagnostics'], '1');
  assert.equal(new URL(diagnosticReads[0].url).searchParams.get('pet'), 'pet-1');
  assert.equal(new URL(diagnosticReads[0].url).searchParams.get('diagnostics'), '1');
  await section.getByText('ignored or blocked：proactive cooldown active', { exact: true }).waitFor();
  await section.getByText('Expression strategy：warm and restrained', { exact: true }).waitFor();
  await section.getByText('Animation selection：开心转圈', { exact: true }).waitFor();
  await section.getByText('before：calm · valence 0.00 / arousal 0.35', { exact: true }).waitFor();
  await section.getByText('after：cheerful · valence 0.28 / arousal 0.47', { exact: true }).waitFor();
  await section.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.dsh-pet-diagnostics button[disabled]'));
  assert.equal(diagnosticReads.length, 2);
  await page.getByRole('button', { name: 'Green (240px)', exact: true }).click();
  await section.getByText('Local build：emotion-mvp1.1-20261023.1 / 0.3.7-emotion.1.1', { exact: true }).waitFor();
  assert.equal(diagnosticReads.length, 3);
  assert.equal(new URL(diagnosticReads[2].url).searchParams.get('pet'), 'pet-2');
  await page.clock.install();
  await page.clock.runFor(10 * 60_000);
  assert.equal(diagnosticReads.length, 3, 'open diagnostics do not poll');
  await section.getByRole('button', { name: 'Hide local emotion diagnostics', exact: true }).click();
  await page.getByRole('button', { name: 'Blue (240px)', exact: true }).click();
  await page.clock.runFor(10 * 60_000);
  assert.equal(diagnosticReads.length, 3, 'closed diagnostics do not fetch on pet changes');
  assert.deepEqual(writes, []);
  assert.deepEqual(resets, []);
});

for (const failure of ['forbidden', 'http', 'network', 'malformed']) {
  test(`diagnostics ${failure} is explicit, does not expose the response body and can be retried`, async (t) => {
    let fail = true;
    const secret = 'UNEXPECTED-RESPONSE-CONTENT';
    const { page, diagnosticReads, writes } = await open(t, {
      diagnostics: (route) =>
        !fail
          ? route.fulfill({ json: emotionReport })
          : failure === 'network'
            ? route.abort()
            : failure === 'malformed'
              ? route.fulfill({ json: { private: secret } })
              : route.fulfill({ status: failure === 'forbidden' ? 403 : 503, body: secret }),
    });
    await page.getByRole('button', { name: 'Show local emotion diagnostics', exact: true }).click();
    const section = page.getByRole('region', { name: 'Local emotion diagnostics', exact: true });
    await section.getByRole('alert').waitFor();
    assert.match(
      await section.getByRole('alert').textContent(),
      failure === 'forbidden' ? /local, same-origin/ : /Refresh to retry/,
    );
    assert.equal(await page.getByText(secret, { exact: false }).count(), 0);
    fail = false;
    await section.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
    await section.getByText('Local build：emotion-mvp1.1-20261023.1 / 0.3.7-emotion.1.1', { exact: true }).waitFor();
    assert.equal(diagnosticReads.length, 2);
    assert.deepEqual(writes, []);
  });
}

test('diagnostics show empty process history and omit unexpected or unbounded fields', async (t) => {
  const secret = 'PRIVATE-FIXTURE-TEXT';
  const diagnostics = {
    ...emotionReport,
    private: secret,
    fullPrompt: secret,
    state: { ...emotionReport.state, chat: secret },
    diagnostics: { ...emotionReport.diagnostics, records: [] },
  };
  const { page } = await open(t, { diagnostics, lang: 'zh' });
  await page.getByRole('button', { name: '展开本地情绪诊断', exact: true }).click();
  const section = page.getByRole('region', { name: '本地情绪诊断', exact: true });
  await section.getByText('本进程尚无诊断记录。', { exact: true }).waitFor();
  assert.match(await section.textContent(), /最多保留 80 条本进程记录，重启清空/);
  assert.match(await section.textContent(), /不代表模型回复质量或真实窗口视觉验收通过/);
  assert.equal(await section.getByText(secret, { exact: false }).count(), 0);
});

test('diagnostics render at most 80 records with safe code fallback at 360px', async (t) => {
  const records = Array.from({ length: 90 }, (_, index) => ({
    ...emotionReport.diagnostics.records[0],
    seq: index + 1,
    event: 'future-event',
    reason: 'future-reason',
    strategy: 'future-strategy',
    chat: 'PRIVATE-FIXTURE-TEXT',
  }));
  const { page } = await open(t, {
    lang: 'zh',
    viewport: { width: 360, height: 800 },
    diagnostics: {
      ...emotionReport,
      diagnostics: { ...emotionReport.diagnostics, records },
    },
  });
  await page.getByRole('button', { name: '展开本地情绪诊断', exact: true }).click();
  const section = page.getByRole('region', { name: '本地情绪诊断', exact: true });
  await section.getByRole('listitem').first().waitFor();
  assert.equal(await section.getByRole('listitem').count(), 80);
  assert.match(await section.getByRole('listitem').first().textContent(), /#90/);
  assert.match(await section.getByRole('listitem').last().textContent(), /#11/);
  assert.match(await section.getByRole('listitem').first().textContent(), /future-reason/);
  assert.equal(await section.getByText('PRIVATE-FIXTURE-TEXT', { exact: false }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

for (const lang of ['en', 'zh']) {
  for (const width of [360, 520, 900]) {
    test(`settings keep controls and toggle labels readable (${lang}, ${width}px)`, async (t) => {
      const { page } = await open(t, { viewport: { width, height: 800 }, lang });
      const clipped = await page
        .locator('.dsh-pet-cfg__toggle>label>span')
        .evaluateAll((labels) =>
          labels.filter((label) => label.scrollWidth > label.clientWidth).map((label) => label.textContent),
        );
      assert.deepEqual(clipped, []);
      if (process.env.DSH_PET_UI_ARTIFACTS) {
        mkdirSync(process.env.DSH_PET_UI_ARTIFACTS, { recursive: true });
        await page.screenshot({
          path: join(process.env.DSH_PET_UI_ARTIFACTS, 'settings-' + lang + '-' + width + '.png'),
          fullPage: true,
        });
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    });
  }
}

test('model picker remains anchored while the responsive settings panel is scrolled', async (t) => {
  const { page, writes } = await open(t, { viewport: { width: 900, height: 700 } });
  const trigger = page.locator('.dsh-pet-mp__trigger').first();
  await trigger.click();
  const panel = page.getByRole('menu');
  await panel.waitFor();
  for (const scrollY of [0, 120]) {
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await page.waitForFunction(() => {
      const trigger = document.querySelector('.dsh-pet-mp__trigger').getBoundingClientRect();
      const panel = document.querySelector('.dsh-pet-mp__panel').getBoundingClientRect();
      return Math.abs(panel.left - trigger.left) < 2 && panel.top >= 0 && panel.bottom <= innerHeight;
    });
  }
  await page.getByRole('menuitemradio', { name: 'Follow current conversation' }).click();
  await save(page);
  assert.deepEqual(writes[0].whisperModel, { provider: '', model: '' });
});
