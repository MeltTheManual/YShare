import {
  ANDROID_DOWNLOADS_MIN_API,
  canPublishToDownloads,
  directCacheChildDir,
} from '../src/platform-safety';

describe('public Downloads safety boundary', () => {
  test('requires Android 10 or newer', () => {
    expect(ANDROID_DOWNLOADS_MIN_API).toBe(29);
    expect(canPublishToDownloads('android', 24)).toBe(false);
    expect(canPublishToDownloads('android', 28)).toBe(false);
    expect(canPublishToDownloads('android', 29)).toBe(true);
    expect(canPublishToDownloads('android', 35)).toBe(true);
  });

  test('does not apply the Android API gate to other platforms', () => {
    expect(canPublishToDownloads('ios', 18)).toBe(true);
  });

  test('removes only a picker directory directly under the cache root', () => {
    expect(directCacheChildDir('/data/user/0/app/cache', '/data/user/0/app/cache/abc-123/file.txt'))
      .toBe('/data/user/0/app/cache/abc-123');
    expect(directCacheChildDir('/data/user/0/app/cache/', 'file:///data/user/0/app/cache/abc-123/file.txt'))
      .toBe('/data/user/0/app/cache/abc-123');
    expect(directCacheChildDir('/data/user/0/app/cache', '/data/user/0/app/cache/file.txt')).toBeNull();
    expect(directCacheChildDir('/data/user/0/app/cache', '/data/user/0/app/cache/abc/sub/file.txt')).toBeNull();
    expect(directCacheChildDir('/data/user/0/app/cache', '/data/user/0/app/cache-evil/abc/file.txt')).toBeNull();
  });
});
