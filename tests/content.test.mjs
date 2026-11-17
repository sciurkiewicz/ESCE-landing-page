import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.mjs';

const PASSWORD = 'test-cms-password-42';
const CHANNEL = `UC${'a'.repeat(22)}`;
const VIDEO_URL = 'https://www.youtube.com/watch?v=video000001';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'esce-content-test-'));
  const databasePath = join(directory, 'blog.sqlite');
  const running = new Set();
  t.after(async () => {
    for (const instance of running) await instance.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function start(overrides = {}) {
    const app = createApp({ databasePath, password: PASSWORD, youtubeChannelId: '', youtubeChannelUrl: '', ...options, ...overrides });
    const server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const instance = {
      async request(path, { method = 'GET', body, headers = {}, cookie, csrfToken } = {}) {
        const response = await fetch(`${origin}${path}`, {
          method,
          headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json', Origin: origin } : {}),
            ...(cookie ? { Cookie: cookie } : {}), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...headers },
          ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
        });
        return { status: response.status, headers: response.headers, data: await response.json() };
      },
      async login() {
        const result = await instance.request('/api/admin/login', { method: 'POST', body: { password: PASSWORD } });
        assert.equal(result.status, 200);
        return { cookie: result.headers.get('set-cookie').split(';')[0], csrfToken: result.data.csrfToken };
      },
      async close() {
        if (!running.delete(instance)) return;
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        app.close();
      },
    };
    running.add(instance);
    return instance;
  }
  return { start, ...(await start()) };
}

test('CMS admin routes reuse authentication, CSRF, JSON and origin checks', async (t) => {
  const app = await fixture(t);
  for (const kind of ['projects', 'tools', 'videos']) {
    assert.equal((await app.request(`/api/admin/content/${kind}`)).status, 401);
    assert.equal((await app.request(`/api/admin/content/${kind}`, { method: 'POST', body: { title: 'Test' } })).status, 401);
    assert.equal((await app.request(`/api/admin/content/${kind}/missing`, { method: 'PUT', body: { title: 'Test' } })).status, 401);
    assert.equal((await app.request(`/api/admin/content/${kind}/missing`, { method: 'DELETE' })).status, 401);
  }
  assert.equal((await app.request('/api/admin/settings')).status, 401);
  assert.equal((await app.request('/api/admin/settings', { method: 'PUT' })).status, 401);
  const auth = await app.login();
  for (const path of ['/api/admin/content/projects', '/api/admin/settings']) {
    const method = path.endsWith('settings') ? 'PUT' : 'POST';
    assert.equal((await app.request(path, { method, cookie: auth.cookie, body: { title: 'Test' } })).status, 403);
    assert.equal((await app.request(path, { method, ...auth, headers: { Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await app.request(path, { method, ...auth, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  }
  assert.equal((await app.request('/api/content/unknown')).status, 404);
  assert.equal((await app.request('/api/admin/content/unknown', auth)).status, 404);
});

test('projects, tools and manual videos support CRUD and keep drafts private', async (t) => {
  let time = Date.now();
  const app = await fixture(t, { now: () => time });
  const auth = await app.login();
  for (const kind of ['projects', 'tools', 'videos']) {
    assert.deepEqual((await app.request(`/api/content/${kind}`)).data, { items: [] });
    const created = await app.request(`/api/admin/content/${kind}`, { method: 'POST', ...auth,
      body: { title: 'Nowy materiał', description: 'Opis <script> jako zwykły tekst.', category: 'Gamedev', kind: 'ignored' } });
    assert.equal(created.status, 201);
    const item = created.data.item;
    assert.equal(item.kind, kind);
    assert.equal(item.status, 'draft');
    assert.equal(item.description, 'Opis <script> jako zwykły tekst.');
    assert.match(item.id, /^[a-f0-9-]{36}$/);
    assert.deepEqual((await app.request(`/api/content/${kind}`)).data.items, []);
    assert.equal((await app.request(`/api/admin/content/${kind}`, auth)).data.items.length, 1);
    time += 1000;
    const updated = await app.request(`/api/admin/content/${kind}/${item.id}`, { method: 'PUT', ...auth,
      body: { title: 'Gotowy materiał', status: 'published', url: kind === 'videos' ? VIDEO_URL : '/moj-projekt', image: 'https://images.example.com/image.webp' } });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.item.createdAt, item.createdAt);
    assert.notEqual(updated.data.item.updatedAt, item.updatedAt);
    assert.equal(updated.data.item.title, 'Gotowy materiał');
    assert.equal((await app.request(`/api/content/${kind}`)).data.items[0].id, item.id);
    const otherKind = kind === 'projects' ? 'tools' : 'projects';
    assert.equal((await app.request(`/api/admin/content/${otherKind}/${item.id}`, { method: 'DELETE', ...auth })).status, 404);
    assert.equal((await app.request(`/api/admin/content/${kind}/${item.id}`, { method: 'PUT', ...auth, body: { status: 'draft' } })).status, 200);
    assert.deepEqual((await app.request(`/api/content/${kind}`)).data.items, []);
    assert.deepEqual((await app.request(`/api/admin/content/${kind}/${item.id}`, { method: 'DELETE', ...auth })).data, { deleted: true });
    assert.deepEqual((await app.request(`/api/admin/content/${kind}`, auth)).data.items, []);
  }
});

test('content rejects invalid fields and unsafe URLs while accepting HTTPS and local paths', async (t) => {
  const app = await fixture(t);
  const auth = await app.login();
  for (const body of [
    { title: '' }, { title: 'a'.repeat(161) }, { title: 'Test', description: 'a'.repeat(4001) },
    { title: 'Test', category: 'a'.repeat(81) }, { title: 'Test', status: null },
    ...['http://example.com/', 'javascript:alert(1)', '//example.com/', '/\\example.com/',
      'https://user:password@example.com/', 'https://example.com/\nunsafe'].map((url) => ({ title: 'Test', url })),
    { title: 'Test', image: 'data:image/png;base64,example' },
  ]) {
    const result = await app.request('/api/admin/content/projects', { method: 'POST', ...auth, body });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(typeof result.data.error, 'string');
  }
  const valid = await app.request('/api/admin/content/tools', { method: 'POST', ...auth,
    body: { title: 'Narzędzie', url: '/narzedzia#paleta', image: '/images/paleta.webp', status: 'published' } });
  assert.equal(valid.status, 201);
  assert.equal(valid.data.item.url, '/narzedzia#paleta');
});

test('published manual videos require a valid YouTube video URL', async (t) => {
  const app = await fixture(t);
  const auth = await app.login();
  for (const url of [VIDEO_URL, 'https://www.youtube.com/shorts/video000002', 'https://youtu.be/video000003?t=10']) {
    const result = await app.request('/api/admin/content/videos', { method: 'POST', ...auth, body: { title: 'Film', url, status: 'published' } });
    assert.equal(result.status, 201);
  }
  for (const url of ['', '/filmy', 'https://example.com/watch?v=video000001', 'https://youtube.com/@Channel',
    'https://youtube.com/watch?v=short', 'https://youtu.be/video000001/extra', 'https://youtube.com/watch?v=video000001&v=video000002']) {
    assert.equal((await app.request('/api/admin/content/videos', { method: 'POST', ...auth, body: { title: 'Film', url, status: 'published' } })).status, 400, url);
  }
});

test('settings return complete public values, support partial updates, and clear optional fields', async (t) => {
  const app = await fixture(t);
  const defaults = { siteName: 'ESCE', email: '', youtubeUrl: '', youtubeChannelId: '', githubUrl: '', discordUrl: '', about: '' };
  assert.deepEqual((await app.request('/api/settings')).data, { settings: defaults });
  const auth = await app.login();
  const settings = { siteName: 'Moje ESCE', email: 'autor@example.com', youtubeUrl: 'https://youtube.com/@MyChannel?si=tracking',
    youtubeChannelId: CHANNEL, githubUrl: 'https://github.com/author', discordUrl: 'https://discord.gg/example', about: '    kod\n\n**O mnie**\n' };
  const saved = await app.request('/api/admin/settings', { method: 'PUT', ...auth, body: settings });
  assert.equal(saved.status, 200);
  const expected = { ...settings, youtubeUrl: 'https://www.youtube.com/@MyChannel' };
  assert.deepEqual(saved.data.settings, expected);
  assert.deepEqual((await app.request('/api/settings')).data.settings, expected);
  assert.deepEqual((await app.request('/api/admin/settings', auth)).data.settings, expected);
  const cleared = await app.request('/api/admin/settings', { method: 'PUT', ...auth,
    body: { email: '', youtubeUrl: '', youtubeChannelId: '', githubUrl: '', discordUrl: '', about: '' } });
  assert.deepEqual(cleared.data.settings, { ...defaults, siteName: 'Moje ESCE' });
});

test('settings validate names, e-mail, channel identity, links and Markdown size', async (t) => {
  const app = await fixture(t);
  const auth = await app.login();
  for (const body of [{ siteName: '' }, { siteName: 'a'.repeat(61) }, { email: 'not-an-email' }, { email: 'a'.repeat(255) },
    { youtubeChannelId: 'invalid' }, { youtubeUrl: 'https://example.com/@Channel' }, { youtubeUrl: VIDEO_URL },
    { githubUrl: 'http://github.com/author' }, { discordUrl: 'https://user:pass@discord.gg/example' }, { about: 'a'.repeat(30_001) }]) {
    const result = await app.request('/api/admin/settings', { method: 'PUT', ...auth, body });
    assert.equal(result.status, 400, JSON.stringify(body).slice(0, 150));
  }
});

test('content and settings persist after a server restart', async (t) => {
  const app = await fixture(t);
  const auth = await app.login();
  const created = await app.request('/api/admin/content/projects', { method: 'POST', ...auth,
    body: { title: 'Trwały projekt', description: 'Zapisany na dysku.', status: 'published' } });
  assert.equal((await app.request('/api/admin/settings', { method: 'PUT', ...auth,
    body: { siteName: 'Zapisane ESCE', about: '# Witaj' } })).status, 200);
  await app.close();
  const restarted = await app.start();
  assert.equal((await restarted.request('/api/content/projects')).data.items[0].id, created.data.item.id);
  assert.equal((await restarted.request('/api/settings')).data.settings.siteName, 'Zapisane ESCE');
  assert.equal((await restarted.request('/api/settings')).data.settings.about, '# Witaj');
});

test('initial environment fallback is visible and saved settings control feed invalidation and disabling', async (t) => {
  const configurations = [];
  const app = await fixture(t, { youtubeChannelId: CHANNEL, youtubeChannelUrl: 'https://www.youtube.com/@Initial',
    youtubeFactory: (configuration) => {
      configurations.push(configuration);
      return { getVideos: async () => ({ configured: Boolean(configuration.channelId || configuration.channelUrl),
        channelUrl: configuration.channelUrl, videos: [] }) };
    } });
  const initial = (await app.request('/api/settings')).data.settings;
  assert.equal(initial.youtubeChannelId, CHANNEL);
  assert.equal(initial.youtubeUrl, 'https://www.youtube.com/@Initial');
  assert.equal((await app.request('/api/videos')).data.configured, true);
  await app.request('/api/videos');
  assert.equal(configurations.length, 1);
  const auth = await app.login();
  await app.request('/api/admin/settings', { method: 'PUT', ...auth,
    body: { youtubeUrl: 'https://www.youtube.com/@Changed', youtubeChannelId: '' } });
  await app.request('/api/videos');
  assert.equal(configurations.length, 2);
  assert.equal(configurations[1].channelUrl, 'https://www.youtube.com/@Changed');
  await app.request('/api/admin/settings', { method: 'PUT', ...auth, body: { youtubeUrl: '', youtubeChannelId: '' } });
  assert.equal((await app.request('/api/videos')).data.configured, false);
  await app.close();
  const restarted = await app.start();
  assert.equal((await restarted.request('/api/videos')).data.configured, false);
  const saved = (await restarted.request('/api/settings')).data.settings;
  assert.equal(saved.youtubeUrl, '');
  assert.equal(saved.youtubeChannelId, '');
});
