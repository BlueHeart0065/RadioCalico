// tests/connectivity.test.js
// Network tests: verifies the live HLS stream endpoint is reachable and valid.
// These tests make real HTTP requests – run with a live internet connection.

'use strict';

const STREAM_URL = 'https://d3d4yli4hf5bmh.cloudfront.net/hls/live.m3u8';
const TIMEOUT_MS = 10_000;

describe('Stream connectivity', () => {

  it('manifest URL returns HTTP 200', async () => {
    const res = await fetch(STREAM_URL);
    expect(res.status).toBe(200);
  }, TIMEOUT_MS);

  it('Content-Type header indicates an HLS playlist', async () => {
    const res  = await fetch(STREAM_URL);
    const type = res.headers.get('content-type') || '';
    // Servers may send application/vnd.apple.mpegurl, application/x-mpegurl,
    // audio/mpegurl, or application/octet-stream for .m3u8 files
    expect(type).toMatch(/mpegurl|octet-stream/i);
  }, TIMEOUT_MS);

  it('manifest body begins with #EXTM3U tag', async () => {
    const res  = await fetch(STREAM_URL);
    const text = await res.text();
    expect(text.trimStart()).toMatch(/^#EXTM3U/);
  }, TIMEOUT_MS);

  it('master playlist contains at least one #EXT-X-STREAM-INF entry', async () => {
    const res  = await fetch(STREAM_URL);
    const text = await res.text();
    expect(text).toMatch(/#EXT-X-STREAM-INF/);
  }, TIMEOUT_MS);

  it('master playlist references child .m3u8 playlists', async () => {
    const res  = await fetch(STREAM_URL);
    const text = await res.text();
    expect(text).toMatch(/\.m3u8/);
  }, TIMEOUT_MS);

  it('a child media playlist contains #EXTINF segment entries', async () => {
    const masterRes  = await fetch(STREAM_URL);
    const masterText = await masterRes.text();

    // Extract the first child playlist path from the master
    const childPath = masterText.split('\n')
      .map(l => l.trim())
      .find(l => l.endsWith('.m3u8') && !l.startsWith('#'));

    expect(childPath).toBeDefined();

    const base      = STREAM_URL.substring(0, STREAM_URL.lastIndexOf('/') + 1);
    const childRes  = await fetch(base + childPath);
    const childText = await childRes.text();

    expect(childText).toMatch(/#EXTINF/);
  }, TIMEOUT_MS);

  it('stream advertises a lossless FLAC rendition', async () => {
    const res  = await fetch(STREAM_URL);
    const text = await res.text();
    expect(text).toMatch(/fLaC|flac/i);
  }, TIMEOUT_MS);

  it('responds within 5 seconds', async () => {
    const start = Date.now();
    await fetch(STREAM_URL);
    expect(Date.now() - start).toBeLessThan(5_000);
  }, TIMEOUT_MS);
});
