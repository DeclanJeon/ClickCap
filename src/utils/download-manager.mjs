export async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);

  try {
    const downloadId = await startDownload({
      url,
      filename,
      conflictAction: 'uniquify'
    });
    await waitForDownload(downloadId);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function startDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(downloadId);
    });
  });
}

function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      chrome.downloads.onChanged.removeListener(onChanged);
      if (error) reject(error);
      else resolve();
    };

    const settleFromState = (state, reason) => {
      if (state === 'complete') finish();
      if (state === 'interrupted') {
        finish(new Error(reason || 'The browser interrupted the recording download.'));
      }
    };

    const onChanged = (delta) => {
      if (delta.id === downloadId && delta.state) {
        settleFromState(delta.state.current, delta.error?.current);
      }
    };

    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId }, (items) => {
      const searchError = chrome.runtime.lastError;
      if (searchError) {
        finish(new Error(searchError.message));
        return;
      }

      const download = items[0];
      if (!download) {
        finish(new Error('Chrome could not find the recording download.'));
        return;
      }
      settleFromState(download.state, download.error);
    });
  });
}
