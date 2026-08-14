export const ANDROID_DOWNLOADS_MIN_API = 29;

/**
 * RNBlobUtil publishes to Android's scoped MediaStore Downloads collection.
 * That collection and RELATIVE_PATH support begin on Android 10 (API 29).
 */
export function canPublishToDownloads(os: string, version: number): boolean {
  return os !== 'android'
    || (Number.isFinite(version) && version >= ANDROID_DOWNLOADS_MIN_API);
}

/**
 * `keepLocalCopy(..., cachesDirectory)` may place a picked file in a generated
 * direct child directory such as `<cache>/<uuid>/<file>`. Return only that
 * generated directory; never return the cache root, a nested path, or a path
 * outside the cache. This lets terminal cleanup remove empty picker folders
 * without broad filesystem authority.
 */
export function directCacheChildDir(cacheRoot: string, filePath: string): string | null {
  const root = String(cacheRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const file = String(filePath || '').replace(/^file:\/\//, '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!root || !file.startsWith(root + '/')) return null;
  const relative = file.slice(root.length + 1);
  const parts = relative.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return `${root}/${parts[0]}`;
}
