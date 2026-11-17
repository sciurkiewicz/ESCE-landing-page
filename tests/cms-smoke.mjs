import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staticDirectory = join(projectDirectory, 'dist');
assert.ok(existsSync(join(staticDirectory, 'index.html')), 'Build the application first: npm run build');
const executablePath = [
  process.env.BROWSER_EXECUTABLE,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((candidate) => candidate && existsSync(candidate));
assert.ok(executablePath, 'Install Chrome/Edge or set BROWSER_EXECUTABLE to a Chromium executable.');

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'esce-cms-smoke-'));
const screenshotDirectory = process.env.CMS_CAPTURE_SCREENSHOTS === '1'
  ? await mkdtemp(join(tmpdir(), 'esce-cms-visual-')) : null;
const password = randomBytes(32).toString('base64url');
let app;
let server;
let browser;
let origin;
let activePage;
let stage = 'startup';
let pendingConfirmation = false;
const runtimeErrors = [];
const unexpectedDialogs = [];
const screenshots = [];

function observe(page) {
  page.setDefaultTimeout(10_000);
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('dialog', async (dialog) => {
    if (pendingConfirmation && dialog.type() === 'confirm' && /^Usunąć/.test(dialog.message())) {
      pendingConfirmation = false;
      await dialog.accept();
    } else {
      unexpectedDialogs.push(`${dialog.type()}: ${dialog.message()}`);
      await dialog.dismiss();
    }
  });
  return page;
}

async function browserContext(options = {}) {
  const context = await browser.newContext(options);
  // A real feed is injected as empty; video thumbnails are local fixtures, never network requests.
  await context.route(/^https:\/\/(?:i\.ytimg\.com|img\.youtube\.com)\//, (route) => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#181818"/><path d="m270 140 110 60-110 60z" fill="#eee"/></svg>',
  }));
  return context;
}

async function mutate(page, method, pathname, action) {
  const pending = page.waitForResponse((response) => new URL(response.url()).pathname === pathname
    && response.request().method() === method);
  await action();
  const response = await pending;
  const body = await response.json();
  assert.ok(response.ok(), `${method} ${pathname}: ${response.status()} ${JSON.stringify(body)}`);
  return body;
}

async function idle(admin) {
  await admin.locator('#app[aria-busy="false"]').waitFor();
}

async function confirmDelete(action) {
  pendingConfirmation = true;
  await action();
  assert.equal(pendingConfirmation, false, 'Deletion must show its native confirmation dialog.');
}

async function readPublic(pathname) {
  const response = await fetch(`${origin}${pathname}`);
  assert.ok(response.ok, `GET ${pathname}: ${response.status}`);
  return response.json();
}

async function screenshot(page, name) {
  if (!screenshotDirectory) return;
  await page.evaluate(() => document.fonts.ready);
  const path = join(screenshotDirectory, `${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  screenshots.push(path);
}

async function layout(page, columns) {
  const result = await page.evaluate(() => {
    const grid = document.querySelector('.collection-grid');
    const first = [...grid.children].slice(0, 3).map((item) => {
      const rect = item.getBoundingClientRect();
      return { top: rect.top, left: rect.left, width: rect.width };
    });
    const gridRect = grid.getBoundingClientRect();
    const headingRect = document.querySelector('#app h1').getBoundingClientRect();
    const headerRect = document.querySelector('.site-header').getBoundingClientRect();
    return {
      columns: getComputedStyle(grid).gridTemplateColumns.split(/\s+/).length,
      first,
      center: (gridRect.left + gridRect.right) / 2,
      width: innerWidth,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      headerBottom: headerRect.bottom,
      headingTop: headingRect.top,
    };
  });
  assert.equal(result.columns, columns, `Gallery columns: ${JSON.stringify(result)}`);
  assert.ok(Math.abs(result.center - result.width / 2) <= 1, 'Gallery must be centered in the viewport.');
  assert.ok(result.scrollWidth <= result.width + 1, `Horizontal overflow: ${JSON.stringify(result)}`);
  assert.ok(result.headingTop >= result.headerBottom, `Header overlaps content: ${JSON.stringify(result)}`);
  if (columns === 3) assert.ok(result.first.every((item) => Math.abs(item.top - result.first[0].top) <= 1));
  if (columns === 1) assert.ok(result.first[1].top > result.first[0].top, 'Mobile cards must form one column.');
}

try {
  app = createApp({
    databasePath: join(temporaryDirectory, 'blog.sqlite'), staticDirectory, password,
    secureCookies: false, siteOrigin: null, youtubeChannelId: '', youtubeChannelUrl: '',
    youtube: { getVideos: async () => ({ configured: false, channelUrl: '', videos: [] }) },
  });
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath, headless: true });
  const publicContext = await browserContext({ viewport: { width: 1440, height: 900 } });
  const page = activePage = observe(await publicContext.newPage());

  stage = 'public gallery layout and contact placeholder';
  for (const kind of ['tools', 'projects', 'videos']) {
    await page.goto(`${origin}/${kind}`);
    await page.locator('.collection-card').first().waitFor();
    assert.equal(await page.locator('.collection-card').count(), 6, `Expected empty-state placeholders for ${kind}.`);
    await layout(page, 3);
    await screenshot(page, `desktop-${kind}`);
  }
  await page.goto(`${origin}/contact`);
  await page.locator('.contact-placeholder').waitFor();
  assert.equal(await page.locator('a[href^="mailto:"]').count(), 0);
  await screenshot(page, 'desktop-contact');
  await page.goto(`${origin}/blog`);
  await page.locator('.blog-card').first().waitFor();
  await screenshot(page, 'desktop-blog');
  const mobileContext = await browserContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = activePage = observe(await mobileContext.newPage());
  for (const kind of ['tools', 'projects', 'videos']) {
    await mobile.goto(`${origin}/${kind}`);
    await mobile.locator('.collection-card').first().waitFor();
    await layout(mobile, 1);
    if (kind === 'tools') await screenshot(mobile, 'mobile-tools');
  }
  await mobileContext.close();
  console.log('PASS public: centered three-column galleries, mobile single-column layouts without overflow/header overlap, contact placeholder');

  stage = 'CMS password login';
  const adminContext = await browserContext({ viewport: { width: 1440, height: 1000 } });
  const admin = activePage = observe(await adminContext.newPage());
  await admin.goto(`${origin}/adminpanel`);
  await admin.locator('#admin-password').fill('intentionally-incorrect-password');
  const rejectedLogin = admin.waitForResponse((response) => response.url().endsWith('/api/admin/login'));
  await admin.locator('#admin-login-form button[type="submit"]').click();
  assert.equal((await rejectedLogin).status(), 401);
  await admin.locator('#admin-notice[role="alert"]').waitFor();
  assert.match(await admin.locator('#admin-notice').textContent(), /Nieprawidłowe hasło/);
  await admin.locator('#admin-password').fill(password);
  await mutate(admin, 'POST', '/api/admin/login', () => admin.locator('#admin-login-form button[type="submit"]').click());
  await admin.locator('[data-tab="settings"]').waitFor();
  await idle(admin);
  console.log('PASS authentication: wrong password rejected and correct password opens CMS');

  for (const kind of ['projects', 'tools', 'videos']) {
    stage = `${kind}: draft, publish, edit, persistence, delete`;
    const path = `/api/admin/content/${kind}`;
    const title = `Test CMS ${kind}`;
    const editedTitle = `${title} — poprawiony`;
    const url = kind === 'videos' ? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' : '/about';
    await admin.locator(`[data-tab="${kind}"]`).click();
    await admin.locator('#cms-new').waitFor();
    await idle(admin);
    await admin.locator('#cms-new').click();
    await admin.locator('#cms-title').fill(title);
    await admin.locator('#cms-description').fill(`Zapisany opis ${kind}.`);
    await admin.locator('#cms-url').fill(url);
    await admin.locator('#cms-category').fill('Testy CMS');
    const { item } = await mutate(admin, 'POST', path, () => admin.locator('#cms-item-form [data-status="draft"]').click());
    await idle(admin);
    assert.equal(item.status, 'draft');
    assert.equal((await readPublic(`/api/content/${kind}`)).items.some((entry) => entry.id === item.id), false);
    await page.goto(`${origin}/${kind}`);
    await page.locator('.collection-card').first().waitFor();
    assert.equal(await page.getByRole('heading', { name: title, exact: true }).count(), 0);

    const published = await mutate(admin, 'PUT', `${path}/${item.id}`, () => admin.locator('#cms-item-form [data-status="published"]').click());
    await idle(admin);
    assert.equal(published.item.status, 'published');
    await page.reload();
    await page.getByRole('heading', { name: new RegExp(`^${title}`) }).waitFor();
    assert.equal((await readPublic(`/api/content/${kind}`)).items.filter((entry) => entry.id === item.id).length, 1);

    await admin.locator('#cms-title').fill(editedTitle);
    await admin.locator('#cms-description').fill(`Poprawiony opis ${kind}.`);
    if (kind === 'projects') {
      // A genuine failed save must preserve the author's in-memory changes for retry.
      await admin.route(`**${path}/${item.id}`, (route) => route.fulfill({
        status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Testowa przerwa zapisu.' }),
      }), { times: 1 });
      const failedWrite = admin.waitForResponse((response) => new URL(response.url()).pathname === `${path}/${item.id}`
        && response.request().method() === 'PUT');
      await admin.locator('#cms-item-form [data-status="published"]').click();
      assert.equal((await failedWrite).status(), 503);
      await idle(admin);
      await admin.locator('#admin-notice[role="alert"]').waitFor();
      assert.equal(await admin.locator('#cms-title').inputValue(), editedTitle);
      assert.equal(await admin.locator('#cms-description').inputValue(), `Poprawiony opis ${kind}.`);
      assert.equal(await admin.locator('#cms-unsaved').textContent(), 'Niezapisane zmiany');
    }
    await mutate(admin, 'PUT', `${path}/${item.id}`, () => admin.locator('#cms-item-form [data-status="published"]').click());
    await idle(admin);
    await admin.reload();
    await admin.locator(`[data-tab="${kind}"]`).click();
    await idle(admin);
    await admin.locator(`[data-item="${item.id}"]`).click();
    assert.equal(await admin.locator('#cms-title').inputValue(), editedTitle);
    assert.equal(await admin.locator('#cms-description').inputValue(), `Poprawiony opis ${kind}.`);
    await page.reload();
    await page.getByRole('heading', { name: new RegExp(`^${editedTitle}`) }).waitFor();
    await mutate(admin, 'DELETE', `${path}/${item.id}`, () => confirmDelete(() => admin.locator('#cms-delete').click()));
    await idle(admin);
    assert.equal(await admin.locator(`[data-item="${item.id}"]`).count(), 0);
    assert.equal((await readPublic(`/api/content/${kind}`)).items.some((entry) => entry.id === item.id), false);
    await page.reload();
    await page.locator('.is-placeholder').first().waitFor();
    assert.equal(await page.getByRole('heading', { name: new RegExp(`^${editedTitle}`) }).count(), 0);
    console.log(`PASS ${kind}: draft privacy, public publication, edit/reload persistence, confirmed deletion${kind === 'projects' ? ', failed-save draft recovery' : ''}`);
  }

  stage = 'site settings, contact and sanitized About content';
  const about = '## Mój warsztat\n\n**Bezpieczna treść** o tworzeniu gier.\n\n<script>window.__cmsExecuted = true</script>\n<img alt="test" onerror="window.__cmsExecuted=true">\n<a href="javascript:window.__cmsExecuted=true">Niebezpieczny link</a>';
  await admin.locator('[data-tab="settings"]').click();
  await admin.locator('#cms-settings-form').waitFor();
  await idle(admin);
  await admin.locator('#cms-site-name').fill('Warsztat testowy');
  await admin.locator('#cms-email').fill('owner@example.com');
  await admin.locator('#cms-about').fill(about);
  await mutate(admin, 'PUT', '/api/admin/settings', () => admin.locator('#cms-settings-form [type="submit"]').click());
  await idle(admin);
  await page.goto(`${origin}/contact`);
  await page.locator('.contact-email').waitFor();
  assert.equal(await page.locator('.contact-email').getAttribute('href'), 'mailto:owner@example.com');
  assert.equal(await page.locator('.site-name').textContent(), 'Warsztat testowy');
  await page.goto(`${origin}/about`);
  await page.locator('.about-body strong').waitFor();
  assert.equal(await page.locator('.about-body strong').textContent(), 'Bezpieczna treść');
  assert.equal(await page.locator('.about-body script, .about-body [onerror], .about-body a[href^="javascript:"]').count(), 0);
  assert.equal(await page.evaluate(() => window.__cmsExecuted), undefined);
  await admin.reload();
  await admin.locator('[data-tab="settings"]').click();
  await idle(admin);
  assert.equal(await admin.locator('#cms-site-name').inputValue(), 'Warsztat testowy');
  assert.equal(await admin.locator('#cms-email').inputValue(), 'owner@example.com');
  assert.equal(await admin.locator('#cms-about').inputValue(), about);
  await admin.locator('#cms-email').fill('');
  await mutate(admin, 'PUT', '/api/admin/settings', () => admin.locator('#cms-settings-form [type="submit"]').click());
  await idle(admin);
  await page.goto(`${origin}/contact`);
  await page.locator('.contact-placeholder').waitFor();
  assert.equal(await page.locator('a[href^="mailto:"]').count(), 0);
  assert.equal((await readPublic('/api/settings')).settings.email, '');
  console.log('PASS settings: brand/email/About saved, persisted across reload, Markdown sanitized, clearing email removes contact link');

  stage = 'blog editor lifecycle and article links';
  await admin.locator('[data-tab="blog"]').click();
  await idle(admin);
  await admin.locator('#admin-new').click();
  await admin.locator('#admin-title').fill('Testowy devlog CMS');
  await admin.locator('#admin-category').fill('Devlog');
  await admin.locator('#admin-excerpt').fill('Zapowiedź testowego wpisu.');
  await admin.locator('#admin-content').fill('## Pierwszy prototyp\n\n**Gotowy do testów.**');
  const { post } = await mutate(admin, 'POST', '/api/admin/posts', () => admin.locator('#admin-editor-form [data-status="draft"]').click());
  await idle(admin);
  assert.equal((await fetch(`${origin}/api/posts/${post.slug}`)).status, 404);
  await mutate(admin, 'PUT', `/api/admin/posts/${post.id}`, () => admin.locator('#admin-editor-form [data-status="published"]').click());
  await idle(admin);
  await page.goto(`${origin}/blog`);
  await page.getByRole('link', { name: 'Testowy devlog CMS', exact: true }).click();
  await page.waitForURL(`${origin}/blog/${post.slug}`);
  await page.locator('.blog-prose strong').waitFor();
  assert.equal(await page.locator('.blog-prose strong').textContent(), 'Gotowy do testów.');
  await admin.locator('#admin-title').fill('Poprawiony devlog CMS');
  await admin.locator('#admin-content').fill('## Poprawiony prototyp\n\n**Zapisana poprawka.**');
  await mutate(admin, 'PUT', `/api/admin/posts/${post.id}`, () => admin.locator('#admin-editor-form [data-status="published"]').click());
  await idle(admin);
  await admin.reload();
  await idle(admin);
  await admin.locator(`[data-post="${post.id}"]`).click();
  assert.equal(await admin.locator('#admin-title').inputValue(), 'Poprawiony devlog CMS');
  assert.match(await admin.locator('#admin-content').inputValue(), /Zapisana poprawka/);
  await page.reload();
  await page.getByRole('heading', { name: 'Poprawiony devlog CMS', exact: true }).waitFor();
  await mutate(admin, 'DELETE', `/api/admin/posts/${post.id}`, () => confirmDelete(() => admin.locator('#admin-delete').click()));
  await idle(admin);
  assert.equal((await fetch(`${origin}/api/posts/${post.slug}`)).status, 404);
  await page.reload();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').textContent(), /Nie znaleziono tego wpisu/);
  console.log('PASS blog: draft privacy, publication, article navigation/Markdown, edit persistence, confirmed deletion');

  stage = 'logout and protected API access';
  const priorSession = await (await adminContext.request.get(`${origin}/api/admin/session`)).json();
  await mutate(admin, 'POST', '/api/admin/logout', () => admin.locator('#admin-logout').click());
  await admin.locator('#admin-password').waitFor();
  for (const path of ['/api/admin/settings', '/api/admin/posts', '/api/admin/content/projects', '/api/admin/content/tools', '/api/admin/content/videos']) {
    assert.equal((await adminContext.request.get(`${origin}${path}`)).status(), 401, `Protected read after logout: ${path}`);
  }
  assert.equal((await adminContext.request.put(`${origin}/api/admin/settings`, {
    headers: { Origin: origin, 'X-CSRF-Token': priorSession.csrfToken }, data: { email: 'blocked@example.com' },
  })).status(), 401);
  assert.equal((await adminContext.request.post(`${origin}/api/admin/content/projects`, {
    headers: { Origin: origin, 'X-CSRF-Token': priorSession.csrfToken }, data: { title: 'Blocked', status: 'draft' },
  })).status(), 401);
  assert.equal((await adminContext.request.post(`${origin}/api/admin/posts`, {
    headers: { Origin: origin, 'X-CSRF-Token': priorSession.csrfToken }, data: { title: 'Blocked', category: 'Test', status: 'draft' },
  })).status(), 401);
  assert.deepEqual(unexpectedDialogs, [], 'Unexpected native dialogs or beforeunload prompts');
  assert.deepEqual(runtimeErrors, [], 'Browser JavaScript runtime errors');
  console.log('PASS logout: protected settings, all resource lists, blog and mutation endpoints reject access');
  if (screenshots.length) console.log(`Visual QA screenshots:\n${screenshots.join('\n')}`);
  console.log('CMS browser smoke suite passed.');
} catch (error) {
  console.error(`CMS browser smoke suite failed during: ${stage}`);
  if (activePage && !activePage.isClosed()) console.error(`Screen: ${activePage.url()}`);
  console.error(error);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); }
  finally {
    try {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    } finally {
      app?.close();
      const temporaryRoot = await realpath(tmpdir());
      const actualDirectory = await realpath(temporaryDirectory);
      const relativeDirectory = relative(temporaryRoot, actualDirectory);
      assert.ok(relativeDirectory && !isAbsolute(relativeDirectory) && relativeDirectory !== '..'
        && !relativeDirectory.startsWith(`..${sep}`) && relativeDirectory.startsWith('esce-cms-smoke-'),
      'Refusing to remove a directory outside this smoke test’s temporary root.');
      await rm(actualDirectory, { recursive: true, force: true });
    }
  }
}
