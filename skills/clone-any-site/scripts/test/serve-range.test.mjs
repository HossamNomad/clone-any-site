// test/serve-range.test.mjs — unit tests for rangeRespond (HTTP Range serving)
// Guard the server's .listen() so importing the module doesn't start the server.
// ESM imports are hoisted, so set the env var FIRST then dynamic-import the module.
process.env.CLONE_NO_LISTEN = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { rangeRespond } = await import('../serve-repurpose.mjs');

function mkRes() {
  return {
    code: 0,
    headers: {},
    body: null,
    writeHead(c, h) { this.code = c; this.headers = h || {}; },
    end(b) { this.body = b; }
  };
}

test('no Range header -> 200 full buffer', () => {
  const buf = Buffer.alloc(1000, 7);
  const res = mkRes();
  const req = { headers: {} };
  rangeRespond(req, res, buf, 'video/mp4');
  assert.equal(res.code, 200);
  assert.equal(res.headers['Content-Length'], buf.length);
  assert.equal(res.headers['Accept-Ranges'], 'bytes');
  assert.equal(res.headers['Content-Type'], 'video/mp4');
  assert.ok(Buffer.isBuffer(res.body));
  assert.equal(res.body.length, 1000);
  assert.ok(res.body.equals(buf));
});

test('Range bytes=0-99 -> 206 first 100 bytes', () => {
  const buf = Buffer.alloc(1000, 1);
  const res = mkRes();
  const req = { headers: { range: 'bytes=0-99' } };
  rangeRespond(req, res, buf, 'video/mp4');
  assert.equal(res.code, 206);
  assert.equal(res.headers['Content-Range'], 'bytes 0-99/1000');
  assert.equal(res.headers['Content-Length'], 100);
  assert.equal(res.body.length, 100);
});

test('Range bytes=900- -> 206 to end', () => {
  const buf = Buffer.alloc(1000, 2);
  const res = mkRes();
  const req = { headers: { range: 'bytes=900-' } };
  rangeRespond(req, res, buf, 'video/mp4');
  assert.equal(res.code, 206);
  assert.equal(res.headers['Content-Range'], 'bytes 900-999/1000');
  assert.equal(res.headers['Content-Length'], 100);
  assert.equal(res.body.length, 100);
});

test('Range bytes=-50 (suffix) -> 206 last 50 bytes', () => {
  const buf = Buffer.alloc(1000, 3);
  const res = mkRes();
  const req = { headers: { range: 'bytes=-50' } };
  rangeRespond(req, res, buf, 'video/mp4');
  assert.equal(res.code, 206);
  assert.equal(res.headers['Content-Range'], 'bytes 950-999/1000');
  assert.equal(res.body.length, 50);
});

test('Range bytes=2000-3000 (out of range) -> 416', () => {
  const buf = Buffer.alloc(1000, 4);
  const res = mkRes();
  const req = { headers: { range: 'bytes=2000-3000' } };
  rangeRespond(req, res, buf, 'video/mp4');
  assert.equal(res.code, 416);
  assert.equal(res.headers['Content-Range'], 'bytes */1000');
});
