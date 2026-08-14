'use strict';

// Pure helpers kept outside Electron so the privileged IPC boundary can be
// tested with small fake events.
function isExpectedRendererUrl(candidate, expected) {
  try {
    const actualUrl = new URL(candidate);
    const expectedUrl = new URL(expected);
    return actualUrl.protocol === 'file:'
      && expectedUrl.protocol === 'file:'
      && actualUrl.href === expectedUrl.href;
  } catch {
    return false;
  }
}

function isTrustedRendererEvent(event, trustedWebContents, expectedUrl) {
  if (!event || !trustedWebContents || event.sender !== trustedWebContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== trustedWebContents.mainFrame) return false;
  return isExpectedRendererUrl(frame.url, expectedUrl);
}

module.exports = { isExpectedRendererUrl, isTrustedRendererEvent };
