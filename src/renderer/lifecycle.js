// Small browser/Node helpers for transfer lifecycle safety. Kept separate so
// the disconnect and terminal-message behavior can be regression-tested without
// starting Electron.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.YShareLifecycle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildLifecycle() {
  'use strict';

  function waitForDataChannel(dc, predicate, isCancelled) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;

      const cleanup = () => {
        if (timer !== null) clearInterval(timer);
        dc.removeEventListener('bufferedamountlow', check);
        dc.removeEventListener('close', onClosed);
        dc.removeEventListener('error', onClosed);
      };
      const finish = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err); else resolve();
      };
      const onClosed = () => finish(new Error('data channel closed before queued data drained'));
      function check() {
        if (isCancelled && isCancelled()) {
          finish(new Error('transfer stopped'));
          return;
        }
        if (dc.readyState !== 'open') {
          onClosed();
          return;
        }
        try {
          if (predicate()) finish();
        } catch (err) {
          finish(err);
        }
      }

      dc.addEventListener('bufferedamountlow', check);
      dc.addEventListener('close', onClosed);
      dc.addEventListener('error', onClosed);
      timer = setInterval(check, 50);
      check();
    });
  }

  function waitDrain(dc, isCancelled) {
    return waitForDataChannel(
      dc,
      () => dc.bufferedAmount <= dc.bufferedAmountLowThreshold,
      isCancelled,
    );
  }

  function flush(dc, isCancelled) {
    return waitForDataChannel(dc, () => dc.bufferedAmount === 0, isCancelled);
  }

  function createTerminalAcker(send) {
    let sent = false;
    return (message) => {
      if (sent) return false;
      sent = true;
      send(message);
      return true;
    };
  }

  // A signaling callback may fire long after a newer Quick Connect attempt has
  // replaced it. Keep identity (not just a boolean) so only the exact current
  // attempt and its exact socket are allowed to act.
  function createAttemptGate() {
    let current = null;
    let sequence = 0;

    return {
      start(onReplace) {
        const previous = current;
        if (previous) {
          previous.active = false;
          current = null;
          if (onReplace) onReplace(previous);
        }
        const attempt = {
          token: ++sequence,
          active: true,
          socket: null,
          owner: null,
          handshakeDone: false,
          processing: false,
        };
        current = attempt;
        return attempt;
      },

      bindSocket(attempt, socket) {
        if (!attempt || current !== attempt || !attempt.active || attempt.socket) return false;
        attempt.socket = socket;
        return true;
      },

      isCurrent(attempt, socket = attempt && attempt.socket) {
        return !!attempt && current === attempt && attempt.active && attempt.socket === socket;
      },

      current() { return current; },

      retire(attempt) {
        if (!attempt) return false;
        const wasCurrent = current === attempt && attempt.active;
        attempt.active = false;
        if (current === attempt) current = null;
        return wasCurrent;
      },
    };
  }

  return { waitForDataChannel, waitDrain, flush, createTerminalAcker, createAttemptGate };
});
