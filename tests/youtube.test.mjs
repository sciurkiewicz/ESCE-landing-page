import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../server/app.mjs';
import { createYouTubeFeed, YouTubeFeedError } from '../server/youtube.mjs';

const CHANNEL = `UC${'a'.repeat(22)}`;
const OTHER_CHANNEL = `UC${'b'.repeat(22)}`;
const FEED_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`;

function entry({ id = 'video000001', title = 'Pierwszy film', day = 1, published, channel = CHANNEL, extra = '' } = {}) {
  return `<entry><yt:videoId>${id}</yt:videoId><yt:channelId>${channel}</yt:channelId>
    <title>${title}</title><published>${published ?? `2026-11-${String(day).padStart(2, '0')}T12:00:00+00:00`}</published>${extra}</entry>`;
}

function feed(entries = entry(), channel = CHANNEL) {
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"
    xmlns:yt="http://www.youtube.com/xml/schemas/2015"><yt:channelId>${channel}</yt:channelId>${entries}</feed>`;
}

function service(options = {}) {
  // Explicit values keep tests independent of the machine's environment and never read .env.
  return createYouTubeFeed({ channelId: CHANNEL, channelUrl: '', ...options });
}

test('unconfigured channel is an empty result without upstream requests', async () => {
  let requests = 0;
  const youtube = service({ channelId: '', fetchImpl: async () => { requests += 1; throw new Error('unexpected fetch'); } });
  assert.deepEqual(await youtube.getVideos(), { configured: false, channelUrl: '', videos: [] });
  assert.equal(requests, 0);
});

test('feed returns the newest nine videos, decodes XML titles, and constructs safe links', async () => {
  const entries = Array.from({ length: 12 }, (_, index) => entry({
    id: `video${String(index + 1).padStart(6, '0')}`, day: index + 1,
    title: index === 11 ? 'Gry &amp; kod &lt;3 &quot;ESCE&quot; &#39;dev&#39; &#x1F3AE;'
      : index === 10 ? '<![CDATA[Game &amp; <code>]]>' : `Film ${index + 1}`,
    extra: '<link href="https://untrusted.example/watch"/><media:thumbnail url="https://untrusted.example/image"/>',
  }));
  entries.unshift(entry({ id: 'video000012', day: 1, title: 'Starsza kopia' }));
  entries.push(entry({ id: '../invalid!', day: 20 }), entry({ id: 'invalid0001', published: 'not-a-date' }),
    entry({ id: 'channel0001', channel: OTHER_CHANNEL }));
  const youtube = service({ fetchImpl: async (url, options) => {
    assert.equal(url, FEED_URL);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(feed(entries.join('')));
  } });
  const result = await youtube.getVideos();
  assert.equal(result.configured, true);
  assert.equal(result.channelUrl, `https://www.youtube.com/channel/${CHANNEL}`);
  assert.equal(result.videos.length, 9);
  assert.deepEqual(result.videos.map((video) => video.id),
    [12, 11, 10, 9, 8, 7, 6, 5, 4].map((index) => `video${String(index).padStart(6, '0')}`));
  assert.deepEqual(result.videos[0], {
    id: 'video000012', title: 'Gry & kod <3 "ESCE" \'dev\' 🎮', publishedAt: '2026-11-12T12:00:00.000Z',
    thumbnail: 'https://i.ytimg.com/vi/video000012/hqdefault.jpg',
    url: 'https://www.youtube.com/watch?v=video000012',
  });
  assert.equal(result.videos[1].title, 'Game &amp; <code>');
});

test('channel URLs are canonicalized and a direct ID avoids a channel-page request', async () => {
  const calls = [];
  const youtube = service({ channelId: '', channelUrl: `https://youtube.com/channel/${CHANNEL}/?si=tracking#videos`,
    fetchImpl: async (url) => { calls.push(url); return new Response(feed()); } });
  assert.equal((await youtube.getVideos()).channelUrl, `https://www.youtube.com/channel/${CHANNEL}`);
  assert.deepEqual(calls, [FEED_URL]);
});

test('handle resolution uses channel metadata and remembers the ID between feed refreshes', async () => {
  let time = 1000;
  const calls = [];
  const metadata = JSON.stringify({ metadata: { channelMetadataRenderer: {
    title: 'Kanał', description: 'Cudzysłów " i nawiasy { w opisie }', externalId: CHANNEL,
  } } });
  const youtube = service({ channelId: '', channelUrl: 'https://www.youtube.com/@MyChannel?si=tracking',
    now: () => time, cacheTtlMs: 100,
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(url.includes('/@') ? `<script>var ytInitialData = ${metadata};</script>` : feed());
    } });
  const first = await youtube.getVideos();
  assert.equal(first.channelUrl, 'https://www.youtube.com/@MyChannel');
  assert.equal(first.videos.length, 1);
  time += 101;
  await youtube.getVideos();
  assert.deepEqual(calls, ['https://www.youtube.com/@MyChannel', FEED_URL, FEED_URL]);
});

test('canonical metadata can resolve a handle without taking arbitrary suggested channel IDs', async () => {
  const calls = [];
  const youtube = service({ channelId: '', channelUrl: 'https://youtube.com/@zażółć', fetchImpl: async (url) => {
    calls.push(url);
    return new Response(url.includes('/@')
      ? `<script>{"suggested":{"externalId":"${OTHER_CHANNEL}"}}</script><link href='https://www.youtube.com/channel/${CHANNEL}' rel='canonical'>`
      : feed());
  } });
  assert.equal((await youtube.getVideos()).videos.length, 1);
  assert.deepEqual(calls, ['https://www.youtube.com/@za%C5%BC%C3%B3%C5%82%C4%87', FEED_URL]);
  const unresolved = service({ channelId: '', channelUrl: 'https://www.youtube.com/@Other',
    fetchImpl: async () => new Response(`<script>{"suggested":{"externalId":"${CHANNEL}"}}</script>`) });
  await assert.rejects(unresolved.getVideos(), (error) => error instanceof YouTubeFeedError && error.message.includes('YOUTUBE_CHANNEL_ID'));
});

test('unsafe hosts, credentials, paths and invalid IDs fail without making requests', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('must not fetch'); };
  for (const channelUrl of [
    'http://www.youtube.com/@Channel', 'https://youtube.com.evil.example/@Channel',
    'https://user:pass@www.youtube.com/@Channel', 'https://www.youtube.com:8443/@Channel',
    'https://www.youtube.com@127.0.0.1/@Channel', 'https://youtu.be/video000001',
    'https://www.youtube.com/watch?v=video000001', 'https://www.youtube.com/@Channel%2Fvideos',
    'https://www.youtube.com/channel/invalid', 'file:///etc/passwd',
  ]) {
    await assert.rejects(service({ channelId: '', channelUrl, fetchImpl }).getVideos(), YouTubeFeedError);
  }
  await assert.rejects(service({ channelId: 'invalid', channelUrl: `https://www.youtube.com/channel/${CHANNEL}`, fetchImpl }).getVideos(), YouTubeFeedError);
  assert.equal(calls, 0);
});

test('concurrent readers share one request and fresh results remain cached', async () => {
  let time = 1000;
  let calls = 0;
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const youtube = service({ now: () => time, cacheTtlMs: 100, fetchImpl: async () => {
    calls += 1;
    if (calls === 1) return pending;
    return new Response(feed());
  } });
  const requests = [youtube.getVideos(), youtube.getVideos(), youtube.getVideos()];
  assert.equal(calls, 1);
  complete(new Response(feed()));
  const results = await Promise.all(requests);
  assert.equal(results[0], results[1]);
  time += 99;
  assert.equal(await youtube.getVideos(), results[0]);
  assert.equal(calls, 1);
  time += 2;
  await youtube.getVideos();
  assert.equal(calls, 2);
});

test('upstream failures have a retry cooldown and a later request can recover', async () => {
  let time = 1000;
  let calls = 0;
  const youtube = service({ now: () => time, retryDelayMs: 60_000, fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? new Response('Unavailable', { status: 503 }) : new Response(feed());
  } });
  await assert.rejects(youtube.getVideos(), (error) => error instanceof YouTubeFeedError && error.retryAfter === 60);
  time += 1000;
  await assert.rejects(youtube.getVideos(), (error) => error.retryAfter === 59);
  assert.equal(calls, 1);
  time += 59_001;
  assert.equal((await youtube.getVideos()).videos.length, 1);
  assert.equal(calls, 2);
});

test('malformed XML, DTDs and a mismatched channel are rejected without entity expansion', async () => {
  for (const source of ['<html>Not a feed</html>', feed(entry(), OTHER_CHANNEL),
    `<!DOCTYPE feed [<!ENTITY external SYSTEM "http://127.0.0.1/secret">]>${feed()}`,
    feed('<entry><title>Incomplete</title>')]) {
    await assert.rejects(service({ fetchImpl: async () => new Response(source) }).getVideos(), YouTubeFeedError);
  }
  const empty = await service({ fetchImpl: async () => new Response(feed('')) }).getVideos();
  assert.deepEqual(empty.videos, []);
});

test('feed and channel-page bodies have limits independent of Content-Length', async () => {
  for (const response of [new Response('short', { headers: { 'Content-Length': String(512 * 1024 + 1) } }),
    new Response('a'.repeat(512 * 1024 + 1))]) {
    await assert.rejects(service({ fetchImpl: async () => response }).getVideos(), YouTubeFeedError);
  }
  await assert.rejects(service({ channelId: '', channelUrl: 'https://www.youtube.com/@Channel',
    fetchImpl: async () => new Response('a'.repeat(4 * 1024 * 1024 + 1)) }).getVideos(), YouTubeFeedError);
});

test('slow upstream requests are aborted and reported as a recoverable feed error', async () => {
  let aborted = false;
  const youtube = service({ timeoutMs: 5, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }) });
  await assert.rejects(youtube.getVideos(), YouTubeFeedError);
  assert.equal(aborted, true);
});

async function apiServer(t, youtube) {
  const app = createApp({ databasePath: ':memory:', password: '', youtube });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    app.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('public videos API exposes the feed contract without authentication', async (t) => {
  const origin = await apiServer(t, service({ fetchImpl: async () => new Response(feed()) }));
  const response = await fetch(`${origin}/api/videos`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.configured, true);
  assert.equal(data.channelUrl, `https://www.youtube.com/channel/${CHANNEL}`);
  assert.equal(data.videos[0].id, 'video000001');
});

test('videos API returns JSON 503 and Retry-After when YouTube is unavailable', async (t) => {
  const origin = await apiServer(t, service({ fetchImpl: async () => { throw new Error('upstream unavailable'); } }));
  const response = await fetch(`${origin}/api/videos`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(typeof (await response.json()).error, 'string');
});
