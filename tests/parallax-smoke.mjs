import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(existsSync(join(root, 'dist/index.html')), 'Build the application before running: npm run build');
const executablePath = [
  process.env.BROWSER_EXECUTABLE,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));
assert.ok(executablePath, 'Install Chrome/Edge or set BROWSER_EXECUTABLE to Chromium.');

const app = createApp({
  databasePath: ':memory:', staticDirectory: join(root, 'dist'), password: '',
  secureCookies: false, siteOrigin: null, youtubeChannelId: '', youtubeChannelUrl: '',
  youtube: { getVideos: async () => ({ configured: false, channelUrl: '', videos: [] }) },
});
const server = createServer(app);
const errors = [];
let browser;
let activePage;
let stage = 'startup';
const screenshotDirectory = process.env.PARALLAX_CAPTURE_SCREENSHOTS === '1'
  ? await mkdtemp(join(tmpdir(), 'esce-parallax-visual-')) : null;
const screenshots = [];

function observe(page) {
  page.setDefaultTimeout(10_000);
  page.on('pageerror', (error) => errors.push(error.message));
  return page;
}

async function layers(page, selector = '.landscape-layer') {
  return page.locator(selector).evaluateAll((elements) => elements.map((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { depth: Number(element.dataset.depth), x: matrix.m41, y: matrix.m42 };
  }));
}

function differentMotion(before, after, description) {
  const distances = after.map((layer, index) => ({ depth: layer.depth,
    distance: Math.hypot(layer.x - before[index].x, layer.y - before[index].y) })).sort((a, b) => a.depth - b.depth);
  assert.ok(distances.every((entry) => entry.distance > 0.1), `${description}: all layers should move: ${JSON.stringify(distances)}`);
  assert.ok(distances.slice(1).every((entry, index) => entry.distance > distances[index].distance + 0.1),
  `${description}: nearer layers should move farther: ${JSON.stringify(distances)}`);
}

async function coverage(page, stageSelector = '.parallax-stage', layerSelector = '.landscape-layer') {
  const result = await page.evaluate(({ stageSelector, layerSelector }) => {
    const scene = document.querySelector(stageSelector).getBoundingClientRect();
    return { width: innerWidth, scrollWidth: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
      scene: { left: scene.left, top: scene.top, right: scene.right, bottom: scene.bottom },
      layers: [...document.querySelectorAll(layerSelector)].map((layer) => {
        const rect = layer.getBoundingClientRect();
        const image = layer.querySelector('img');
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          loaded: image.complete && image.naturalWidth > 0 };
      }) };
  }, { stageSelector, layerSelector });
  assert.ok(result.scrollWidth <= result.width + 1, `Horizontal overflow: ${JSON.stringify(result)}`);
  assert.ok(result.layers.every((layer) => layer.loaded && layer.left <= result.scene.left + 1
    && layer.right >= result.scene.right - 1 && layer.top <= result.scene.top + 1
    && layer.bottom >= result.scene.bottom - 1), `Landscape exposes an uncovered edge: ${JSON.stringify(result)}`);
}

async function scrollScene(page, sectionSelector, stageSelector, progress = 0) {
  await page.evaluate(({ sectionSelector, stageSelector, progress }) => {
    const section = document.querySelector(sectionSelector).getBoundingClientRect();
    const scene = document.querySelector(stageSelector).getBoundingClientRect();
    scrollTo({ top: scrollY + section.top + Math.max(0, section.height - scene.height) * progress, behavior: 'instant' });
  }, { sectionSelector, stageSelector, progress });
  await page.waitForTimeout(550);
}

async function capture(page, name) {
  if (!screenshotDirectory) return;
  const path = join(screenshotDirectory, `${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  screenshots.push(path);
}

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
  const page = activePage = observe(await context.newPage());

  stage = 'desktop landscape and centered title';
  await page.goto(origin);
  await page.locator('.landscape-layer').first().waitFor();
  assert.equal(await page.locator('.landscape-layer').count(), 3);
  await page.waitForFunction(() => [...document.querySelectorAll('.landscape-layer img')]
    .every((image) => image.complete && image.naturalWidth > 0));
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.home-title')).opacity) >= 0.99);
  const title = await page.locator('.home-title').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { text: element.textContent, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
      width: rect.width, fontSize: parseFloat(style.fontSize), color: style.color };
  });
  assert.equal(title.text, 'ESCE');
  assert.ok(Math.abs(title.x - 720) < 4 && Math.abs(title.y - 450) < 4, `Title is off-center: ${JSON.stringify(title)}`);
  assert.ok(title.fontSize >= 80 && title.width < 1400 && title.color === 'rgb(255, 255, 255)', 'Title must remain large, white and readable.');
  const initial = await layers(page);
  assert.equal(new Set(initial.map((layer) => layer.depth)).size, 3);
  assert.ok(initial.every((layer) => layer.depth > 0));
  const cue = page.getByRole('link', { name: /Zejdź głębiej/ });
  assert.equal(await cue.getAttribute('href'), '#podziemia');
  assert.ok(await cue.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top > innerHeight * 0.7 && rect.bottom <= innerHeight;
  }), 'The descent cue should be readable at the bottom of the first screen.');
  await coverage(page);
  await capture(page, 'desktop-home');

  stage = 'fine pointer parallax';
  await page.mouse.move(720, 450);
  await page.waitForTimeout(350);
  const centered = await layers(page);
  await page.mouse.move(1400, 850);
  await page.waitForTimeout(700);
  differentMotion(centered, await layers(page), 'Pointer movement');
  await coverage(page);
  console.log('PASS desktop: three loaded landscape layers, centered title and pointer movement at distinct depths');

  stage = 'outdoor scroll parallax and edge coverage';
  const beforeScroll = await layers(page);
  await scrollScene(page, '.surface-section', '.parallax-stage', 1);
  assert.ok(await page.evaluate(() => scrollY > 100), 'The ordinary-motion hero should provide a scroll range.');
  differentMotion(beforeScroll, await layers(page), 'Scroll movement');
  await coverage(page);
  await capture(page, 'scrolled-home');
  console.log('PASS outdoor scroll: nearer layers travel farther and cover their stage through the surface section');

  stage = 'native descent navigation and underground scene';
  await scrollScene(page, '.surface-section', '.parallax-stage');
  await cue.click();
  await page.waitForURL(`${origin}/#podziemia`);
  await page.waitForFunction(() => Math.abs(document.querySelector('#podziemia').getBoundingClientRect().top) < 2);
  await page.getByRole('heading', { name: 'Pod powierzchnią', exact: true }).waitFor();
  await page.getByRole('link', { name: /Zobacz projekty/ }).waitFor();
  assert.equal(await page.getByRole('link', { name: /Zobacz projekty/ }).getAttribute('href'), '/projects');
  assert.equal(await page.locator('.underground-layer').count(), 2);
  await page.waitForFunction(() => [...document.querySelectorAll('.underground-layer img, .soil-bridge img')]
    .every((image) => image.complete && image.naturalWidth > 0));
  await coverage(page, '.underground-stage', '.underground-layer');
  await capture(page, 'underground-entry');
  await scrollScene(page, '.surface-section', '.parallax-stage');
  await cue.focus();
  await cue.press('Enter');
  await page.waitForFunction(() => Math.abs(document.querySelector('#podziemia').getBoundingClientRect().top) < 2);
  const caveBefore = await layers(page, '.underground-layer');
  await scrollScene(page, '#podziemia', '.underground-stage', 1);
  differentMotion(caveBefore, await layers(page, '.underground-layer'), 'Underground scroll');
  await coverage(page, '.underground-stage', '.underground-layer');
  await capture(page, 'underground-home');
  await page.evaluate(() => {
    const cave = document.querySelector('#podziemia').getBoundingClientRect();
    scrollTo({ top: scrollY + cave.top - innerHeight / 2, behavior: 'instant' });
  });
  await page.waitForTimeout(550);
  const seam = await page.evaluate(() => {
    const intervals = [...document.querySelectorAll('.parallax-stage, .underground-stage')]
      .map((element) => element.getBoundingClientRect()).filter((rect) => rect.bottom > 0 && rect.top < innerHeight)
      .sort((a, b) => a.top - b.top);
    let covered = 0;
    for (const rect of intervals) {
      if (rect.top > covered + 1) return false;
      covered = Math.max(covered, rect.bottom);
    }
    return covered >= innerHeight - 1;
  });
  assert.ok(seam, 'The descent must not reveal an empty gap between the two scene stages.');
  await capture(page, 'halfway-descent');
  const directPage = activePage = observe(await context.newPage());
  await directPage.goto(`${origin}/#podziemia`);
  await directPage.locator('.underground-layer').first().waitFor();
  await directPage.waitForFunction(() => Math.abs(document.querySelector('#podziemia').getBoundingClientRect().top) < 2);
  await directPage.reload();
  await directPage.locator('.underground-layer').first().waitFor();
  await directPage.waitForFunction(() => Math.abs(document.querySelector('#podziemia').getBoundingClientRect().top) < 2);
  await directPage.close();
  activePage = page;
  console.log('PASS descent: cue works by click/keyboard, direct fragment URLs survive reload, cave layers move independently and stages overlap without gaps');

  stage = 'mobile and tablet edge coverage';
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await scrollScene(page, '.surface-section', '.parallax-stage');
    await coverage(page);
    if (width === 390) await capture(page, 'mobile-home');
    await scrollScene(page, '.surface-section', '.parallax-stage', 1);
    await coverage(page);
    if (width === 390) {
      await page.evaluate(() => {
        const cave = document.querySelector('#podziemia').getBoundingClientRect();
        scrollTo({ top: scrollY + cave.top - innerHeight / 2, behavior: 'instant' });
      });
      await page.waitForTimeout(550);
      await capture(page, 'mobile-halfway-descent');
    }
    await scrollScene(page, '#podziemia', '.underground-stage');
    await coverage(page, '.underground-stage', '.underground-layer');
    if (width === 390) await capture(page, 'mobile-underground-entry');
    await scrollScene(page, '#podziemia', '.underground-stage', 1);
    await coverage(page, '.underground-stage', '.underground-layer');
    if (width === 390) await capture(page, 'mobile-underground');
  }
  console.log('PASS responsive: both scenes avoid horizontal overflow and exposed edges at 320, 390 and 768 pixels');

  stage = 'reduced motion and preference changes';
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(100);
  const allPlanes = '.landscape-layer, .underground-layer';
  const reduced = await layers(page, allPlanes);
  assert.ok(reduced.every((layer) => Math.abs(layer.x) < 0.1 && Math.abs(layer.y) < 0.1), 'Reduced motion must clear layer transforms.');
  for (const scene of ['.surface-section', '#podziemia']) {
    assert.ok(await page.locator(scene).evaluate((element) => {
      const height = element.getBoundingClientRect().height;
      return height >= innerHeight - 1 && height <= innerHeight + 1;
    }), `Reduced motion should keep ${scene} as one static viewport.`);
  }
  assert.ok(await page.locator('.parallax-stage, .underground-stage').evaluateAll((elements) =>
    elements.every((element) => getComputedStyle(element).position !== 'sticky')), 'Reduced-motion scenes must not stick while scrolling.');
  assert.equal(await page.locator('.home-title').evaluate((element) => getComputedStyle(element).animationName), 'none');
  await capture(page, 'reduced-home');
  await page.mouse.move(50, 750);
  await page.waitForTimeout(200);
  assert.deepEqual(await layers(page, allPlanes), reduced, 'Reduced motion must ignore pointer input.');
  await cue.click();
  await page.waitForFunction(() => Math.abs(document.querySelector('#podziemia').getBoundingClientRect().top) < 2);
  assert.ok(await page.getByRole('heading', { name: 'Pod powierzchnią', exact: true }).isVisible());
  await page.setViewportSize({ width: 390, height: 844 });
  await scrollScene(page, '.surface-section', '.parallax-stage');
  await capture(page, 'reduced-mobile-home');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForTimeout(150);
  const restored = await layers(page);
  await page.mouse.move(1400, 850);
  await page.waitForTimeout(700);
  differentMotion(restored, await layers(page), 'Restored motion preference');
  console.log('PASS accessibility: reduced motion retains two reachable static scenes, clears transforms/intro and responds to live preference changes');

  stage = 'navigation, route isolation and private CMS entry';
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.locator('.header-items a[href="/tools"]').click();
  await page.waitForURL(`${origin}/tools`);
  await page.locator('.collection-card').first().waitFor();
  assert.equal(await page.locator('.landscape-layer, .underground-layer, #podziemia').count(), 0);
  assert.equal(await page.locator('body.home-page').count(), 0);
  assert.equal(await page.locator('a[href="/adminpanel"], a[href="/admin"]').count(), 0);
  await page.goto(`${origin}/blog`);
  await page.locator('.blog-card').first().waitFor();
  assert.equal(await page.locator('a[href="/adminpanel"], a[href="/admin"]').count(), 0);
  await page.goto(`${origin}/adminpanel`);
  await page.getByRole('heading', { name: 'Ustaw hasło do panelu', exact: true }).waitFor();
  assert.equal(await page.locator('.landscape-layer, .underground-layer, body.home-page').count(), 0);
  assert.equal((await page.request.get(`${origin}/admin`)).status(), 404);
  assert.deepEqual(errors, [], 'Browser runtime errors');
  console.log('PASS routes: navigation remains clickable, public pages have no parallax/CMS links and only /adminpanel opens the CMS');
  if (screenshots.length) console.log(`Parallax screenshots:\n${screenshots.join('\n')}`);
  console.log('Parallax browser smoke suite passed.');
} catch (error) {
  console.error(`Parallax browser smoke suite failed during: ${stage}`);
  if (activePage && !activePage.isClosed()) console.error(`Screen: ${activePage.url()}`);
  console.error(error);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); }
  finally {
    try {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    } finally { app.close(); }
  }
}
