// Thrown when the file at the URL is no longer the version we were reading.
export class FileChangedError extends Error {}

// One range request. When `etag` is given, the request is pinned to that
// version of the file: the server is told to refuse if the file has changed
// (If-Match), and the ETag on the answer is checked as well.
export async function fetchRange(url, offset, length, etag) {
  const headers = { Range: `bytes=${offset}-${offset + length - 1}` };
  if (etag) headers['If-Match'] = etag;
  const response = await fetch(url, { headers, cache: 'no-store' });

  // 412: the If-Match check failed. 416: the range is past the end of the
  // file, which for a pinned request means the file was replaced by a shorter one.
  if (response.status === 412 || (etag && response.status === 416)) {
    throw new FileChangedError(`${url} changed on the server`);
  }
  if (response.status !== 206) {
    throw new Error(`Range request to ${url} failed with status ${response.status}`);
  }
  const actual = response.headers.get('ETag');
  if (!actual) throw new Error('Server sent no ETag, so the file version cannot be pinned');
  if (etag && actual !== etag) throw new FileChangedError(`${url} changed on the server`);
  return { data: await response.arrayBuffer(), etag: actual };
}

// How the pmtiles library reads the file. The first answer fixes the version;
// every later read must come from that same version or it throws.
export class PinnedSource {
  constructor(url) {
    this.url = url;
    this.etag = null;
  }
  getKey() {
    return this.url;
  }
  async getBytes(offset, length) {
    const result = await fetchRange(this.url, offset, length, this.etag);
    this.etag ??= result.etag;
    return { data: result.data };
  }
}
