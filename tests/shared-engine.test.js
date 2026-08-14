'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const engine = require('../shared/engine');

const HASH = 'a'.repeat(64);

function descriptions(type) {
  return Array.from({ length: engine.NUM_CONNS }, (_, i) => ({
    type,
    sdp: `v=0\r\na=x-yshare-test:${i}\r\n`,
  }));
}

test('connector codes round-trip exactly eight current descriptions', () => {
  const offers = descriptions('offer');
  assert.deepEqual(engine.decodeCode(engine.encodeDescs(offers)), offers);
  assert.throws(() => engine.encodeDescs(offers.slice(1)), /exactly 8/i);
  assert.throws(() => engine.validateDescriptionArray(descriptions('answer'), 'offer'), /wrong session/i);
});

test('compressed connector codes stop at a bounded expansion size', () => {
  const pako = require('../shared/vendor/pako.min.js');
  const oversized = JSON.stringify(['x'.repeat(engine.PROTOCOL_LIMITS.maxSdpChars * engine.NUM_CONNS + 1)]);
  const code = 'YS1.' + engine.u8ToBase64(pako.deflateRaw(oversized));
  assert.throws(() => engine.decodeCode(code), /expands too large/i);
});

test('file offer and metadata are bound to the accepted name, size, hash, and ranges', () => {
  const offer = engine.validateOfferFile({
    tid: 'transfer-123',
    name: 'report.pdf',
    size: 800,
    locked: true,
  });

  assert.equal(offer.name, 'report.pdf');
  for (let i = 0; i < engine.NUM_CONNS; i++) {
    const range = engine.connRange(i, offer.size, engine.NUM_CONNS);
    assert.deepEqual(
      engine.validateFileMeta({
        tid: offer.tid,
        name: 'report.pdf',
        size: 800,
        hash: HASH,
        start: range.start,
        end: range.end,
      }, offer, i),
      { name: 'report.pdf', size: 800, hash: HASH, start: range.start, end: range.end },
    );
  }

  const first = engine.connRange(0, offer.size, engine.NUM_CONNS);
  assert.throws(() => engine.validateFileMeta({ tid: offer.tid, name: '../report.pdf', size: 800, hash: HASH, ...first }, offer, 0), /changed after acceptance/i);
  assert.throws(() => engine.validateFileMeta({ tid: offer.tid, name: 'report.pdf', size: 801, hash: HASH, ...first }, offer, 0), /changed after acceptance/i);
  assert.throws(() => engine.validateFileMeta({ tid: offer.tid, name: 'report.pdf', size: 800, hash: 'bad', ...first }, offer, 0), /SHA-256/i);
  assert.throws(() => engine.validateFileMeta({ tid: offer.tid, name: 'report.pdf', size: 800, hash: HASH, start: 1, end: 2 }, offer, 0), /byte range/i);
  assert.throws(() => engine.validateFileMeta({ tid: 'other', name: 'report.pdf', size: 800, hash: HASH, ...first }, offer, 0), /changed after acceptance/i);
});

test('folder metadata rejects traversal and inconsistent protocol fields', () => {
  const offer = engine.validateOfferFolder({
    tid: 'folder-123',
    name: 'Photos',
    count: 2,
    totalSize: 100,
  });
  const range = engine.connRange(0, 50, engine.NUM_CONNS);
  const checked = engine.validateFolderMeta({
    tid: offer.tid,
    idx: 0,
    relPath: 'holiday/photo.jpg',
    size: 50,
    hash: HASH,
    start: range.start,
    end: range.end,
    count: 2,
  }, offer, 0);
  assert.equal(checked.relPath, 'holiday/photo.jpg');

  assert.throws(() => engine.validateFolderMeta({ tid: offer.tid, idx: 0, relPath: '../escape', size: 50, hash: HASH, start: range.start, end: range.end, count: 2 }, offer, 0), /unsafe path/i);
  assert.throws(() => engine.validateFolderMeta({ tid: offer.tid, idx: 2, relPath: 'x', size: 50, hash: HASH, start: range.start, end: range.end, count: 2 }, offer, 0), /file index/i);
  assert.throws(() => engine.validateFolderMeta({ tid: offer.tid, idx: 0, relPath: 'x', size: 50, hash: HASH, start: range.start, end: range.end, count: 3 }, offer, 0), /folder count/i);
  assert.throws(() => engine.validateFolderMeta({ tid: offer.tid, idx: 0, relPath: 'x', size: 101, hash: HASH, start: 0, end: 12, count: 2 }, offer, 0), /accepted folder size/i);
});

test('unsafe display names are reduced to names, never paths', () => {
  assert.equal(engine.safeFileName('../invoice?.pdf'), '.._invoice_.pdf');
  assert.equal(engine.safeFileName('CON'), '_CON');
  assert.equal(engine.safeRelativePath('a\\b.txt'), 'a/b.txt');
  assert.throws(() => engine.safeRelativePath('/absolute/file'), /absolute path/i);
  assert.throws(() => engine.validateOfferFile({ tid: 'x', name: 'x', size: -1 }), /file size/i);
  assert.throws(() => engine.validateOfferFile({ tid: '../bad', name: 'x', size: 1 }), /transfer id/i);
  assert.throws(() => engine.base64ToU8('not base64!'), /base64/i);
});

test('password proof matches SHA-256 of transfer id and password', () => {
  const tid = 'abc123';
  const password = 'correct horse battery staple';
  const expected = crypto.createHash('sha256').update(`${tid}:${password}`).digest('hex');
  assert.equal(engine.passwordProof(tid, password), expected);
});

test('signaling endpoints are validated, never guessed, and default to TLS', () => {
  // A bare address is read as SECURE. Guessing cleartext on someone's behalf would
  // quietly downgrade the connection, so it is never inferred.
  assert.equal(engine.parseSignalEndpoint('example.com:8443').ws, 'wss://example.com:8443');
  assert.equal(engine.parseSignalEndpoint('https://example.com').ws, 'wss://example.com');
  assert.equal(engine.parseSignalEndpoint('wss://example.com:8443').http, 'https://example.com:8443');
  assert.equal(engine.parseSignalEndpoint('ws://127.0.0.1:8443').secure, false);

  // Anything that is not exactly a host (+ optional port) is rejected outright.
  for (const bad of [
    'wss://example.com/path',          // paths could smuggle a different target
    'wss://user:pw@example.com',       // embedded credentials
    'javascript:alert(1)',
    'wss://example.com:99999',         // port out of range
    'wss://example.com:0',
    '-bad.example.com',
    'wss://exa mple.com',
    'a'.repeat(engine.MAX_SIGNAL_ENDPOINT_CHARS + 1),
    42,
    null,
  ]) {
    assert.equal(engine.parseSignalEndpoint(bad), null, `must reject ${String(bad)}`);
  }
});

test('cleartext signaling is refused for remote hosts but allowed to this machine', () => {
  const remote = engine.parseSignalEndpoint('ws://198.51.100.7:8443');
  const local = engine.parseSignalEndpoint('ws://localhost:8443');
  const secure = engine.parseSignalEndpoint('wss://example.com');

  assert.match(engine.signalEndpointIssue(remote, false), /secure/i);
  assert.equal(engine.signalEndpointIssue(remote, true), null, 'a dev build may opt in');
  assert.equal(engine.signalEndpointIssue(local, false), null, 'loopback needs no TLS');
  assert.equal(engine.signalEndpointIssue(secure, false), null);
  assert.match(engine.signalEndpointIssue(null, true), /no quick connect server/i);
});

test('with no server configured the app dials nothing and asks nobody for relay credentials', async () => {
  assert.equal(engine.configureSignaling('', {}).ok, true, 'clearing the setting is valid');
  assert.equal(engine.signalingConfigured(), false);
  assert.equal(engine.signalEndpoint(), null);
  await assert.rejects(engine.signalDial(), /no quick connect server is set/);
  assert.equal(await engine.fetchTurnCreds(), null);

  // A rejected address must not become the active endpoint either.
  const rejected = engine.configureSignaling('ws://198.51.100.7:8443', { allowInsecure: false });
  assert.equal(rejected.ok, false);
  assert.equal(engine.signalingConfigured(), false);

  const accepted = engine.configureSignaling('wss://example.com:8443', { allowInsecure: false });
  assert.equal(accepted.ok, true);
  assert.equal(engine.signalEndpoint().ws, 'wss://example.com:8443');
  engine.configureSignaling('', {});   // leave global state clean for other tests
});
