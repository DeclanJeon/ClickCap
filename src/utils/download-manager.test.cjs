const test = require('node:test');
const assert = require('node:assert/strict');

let downloadBlob;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const originalChrome = global.chrome;

test.before(async () => {
  ({ downloadBlob } = await import('./download-manager.mjs'));
});

test.after(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  if (originalChrome === undefined) delete global.chrome;
  else global.chrome = originalChrome;
});

test('WebM object URL remains valid until Chrome completes the download', async () => {
  let listener;
  let revokedUrl = null;
  global.URL.createObjectURL = () => 'blob:clickcap/test';
  global.URL.revokeObjectURL = (url) => { revokedUrl = url; };
  global.chrome = {
    downloads: {
      download: (options, callback) => {
        assert.equal(options.filename, 'capture.webm');
        callback(17);
      },
      onChanged: {
        addListener: (callback) => { listener = callback; },
        removeListener: () => { listener = null; }
      },
      search: (query, callback) => callback([{ id: query.id, state: 'in_progress' }])
    },
    runtime: { lastError: null }
  };

  const pendingDownload = downloadBlob(new Blob(['webm']), 'capture.webm');
  await Promise.resolve();
  assert.equal(revokedUrl, null);
  listener({ id: 17, state: { current: 'complete' } });
  await pendingDownload;
  assert.equal(revokedUrl, 'blob:clickcap/test');
});

test('already-completed downloads do not wait for a missed completion event', async () => {
  let listenerRemoved = false;
  let revokedUrl = null;
  global.URL.createObjectURL = () => 'blob:clickcap/already-complete';
  global.URL.revokeObjectURL = (url) => { revokedUrl = url; };
  global.chrome = {
    downloads: {
      download: (_options, callback) => callback(19),
      onChanged: {
        addListener: () => {},
        removeListener: () => { listenerRemoved = true; }
      },
      search: (query, callback) => callback([{ id: query.id, state: 'complete' }])
    },
    runtime: { lastError: null }
  };

  await downloadBlob(new Blob(['webm']), 'capture.webm');
  assert.equal(listenerRemoved, true);
  assert.equal(revokedUrl, 'blob:clickcap/already-complete');
});

test('interrupted downloads release the object URL and report failure', async () => {
  let listener;
  let revokedUrl = null;
  global.URL.createObjectURL = () => 'blob:clickcap/interrupted';
  global.URL.revokeObjectURL = (url) => { revokedUrl = url; };
  global.chrome = {
    downloads: {
      download: (_options, callback) => callback(23),
      onChanged: {
        addListener: (callback) => { listener = callback; },
        removeListener: () => { listener = null; }
      },
      search: (query, callback) => callback([{ id: query.id, state: 'in_progress' }])
    },
    runtime: { lastError: null }
  };

  const pendingDownload = downloadBlob(new Blob(['webm']), 'capture.webm');
  await Promise.resolve();
  listener({ id: 23, state: { current: 'interrupted' }, error: { current: 'FILE_FAILED' } });
  await assert.rejects(pendingDownload, /FILE_FAILED/);
  assert.equal(revokedUrl, 'blob:clickcap/interrupted');
});
