import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { AnalysisError } from './errors.js';

// Downloads an image from a web address a user gave us, without letting that
// address point the server at itself or at private networks ("SSRF").
// Every DNS answer is checked before connecting, and redirects are re-checked.

const PRIVATE = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) PRIVATE.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32],
]) PRIVATE.addSubnet(addr, prefix, 'ipv6');

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !PRIVATE.check(address, 'ipv4');
  if (family === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return !PRIVATE.check(mapped[1], 'ipv4');
    return !PRIVATE.check(address, 'ipv6');
  }
  return false;
}

/** DNS lookup that refuses to hand back any non-public address. */
export function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, family: options?.family ?? 0 }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) {
      return callback(Object.assign(new Error('Blocked non-public address'), { code: 'EBLOCKED' }));
    }
    if (options?.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif)$/;

export function fetchImageSafely(url, { maxBytes = 4_000_000, timeoutMs = 8000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return reject(new AnalysisError('invalid_image', 400));
    }
    if (!['http:', 'https:'].includes(target.protocol) || (target.port && !['80', '443'].includes(target.port))) {
      return reject(new AnalysisError('invalid_image', 400));
    }

    const client = target.protocol === 'https:' ? https : http;
    const req = client.get(
      target,
      {
        lookup: safeLookup,
        timeout: timeoutMs,
        headers: { 'User-Agent': 'Jachai image check', Accept: 'image/png,image/jpeg,image/webp,image/gif' },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirects <= 0) return reject(new AnalysisError('image_unreadable', 502));
          const next = new URL(res.headers.location, target).href;
          return resolve(fetchImageSafely(next, { maxBytes, timeoutMs, redirects: redirects - 1 }));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new AnalysisError('image_unreadable', 502));
        }
        const type = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (!IMAGE_TYPES.test(type)) {
          res.destroy();
          return reject(new AnalysisError('invalid_image', 400));
        }
        if (Number(res.headers['content-length'] ?? 0) > maxBytes) {
          res.destroy();
          return reject(new AnalysisError('image_too_large', 413));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            reject(new AnalysisError('image_too_large', 413));
          } else {
            chunks.push(chunk);
          }
        });
        res.on('end', () => resolve({ data: Buffer.concat(chunks), mimeType: type }));
        res.on('error', () => reject(new AnalysisError('image_unreadable', 502)));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => reject(new AnalysisError('image_unreadable', 502)));
  });
}

/** Checks the file's first bytes really are the image type it claims to be. */
export function sniffImageType(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}