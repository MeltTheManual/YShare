/* global jest */

const { NativeModules } = require('react-native');

NativeModules.WebRTCModule = {
  addListener: jest.fn(),
  removeListeners: jest.fn(),
  dataChannelSend: jest.fn(),
};
NativeModules.YRawFile = {
  openWrite: jest.fn(() => Promise.resolve(1)),
  writeBatch: jest.fn(() => Promise.resolve(0)),
  closeWrite: jest.fn(() => Promise.resolve()),
  abortWrite: jest.fn(() => Promise.resolve()),
  copyTreeToCache: jest.fn(() => Promise.resolve({ name: 'folder', files: [] })),
};
NativeModules.YForeground = {
  addListener: jest.fn(),
  removeListeners: jest.fn(),
  start: jest.fn(() => Promise.resolve()),
  update: jest.fn(),
  stop: jest.fn(),
};

jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: class RTCPeerConnection {
    close() {}
  },
  RTCSessionDescription: class RTCSessionDescription {
    constructor(value) { Object.assign(this, value); }
  },
}));

jest.mock('react-native-blob-util', () => ({
  __esModule: true,
  default: {
    fs: {
      dirs: { DocumentDir: '/test/documents', CacheDir: '/test/cache' },
      readFile: jest.fn(() => Promise.reject(new Error('no settings file'))),
      writeFile: jest.fn(() => Promise.resolve()),
      unlink: jest.fn(() => Promise.resolve()),
      hash: jest.fn(() => Promise.resolve('a'.repeat(64))),
      stat: jest.fn(() => Promise.resolve({ size: 0 })),
    },
    MediaCollection: {
      copyToMediaStore: jest.fn(() => Promise.resolve('content://test')),
    },
  },
}));

jest.mock('@react-native-clipboard/clipboard', () => ({
  __esModule: true,
  default: { setString: jest.fn(), getString: jest.fn(() => Promise.resolve('')) },
}));

jest.mock('@react-native-documents/picker', () => ({
  pick: jest.fn(),
  pickDirectory: jest.fn(),
  keepLocalCopy: jest.fn(),
  isErrorWithCode: jest.fn(() => false),
  errorCodes: { OPERATION_CANCELED: 'OPERATION_CANCELED' },
}));

jest.mock('react-native-file-access', () => ({
  FileSystem: { readFileChunk: jest.fn() },
}));
