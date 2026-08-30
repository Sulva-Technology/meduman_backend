import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';

/** Reject a URL that could target our own network (SSRF). Scheme + literal-IP host checks. */
export function assertPublicUrl(rawUrl: string, opts: { allowHttp: boolean }): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException('Invalid webhook URL');
  }

  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) {
    throw new BadRequestException('Webhook URL must use https');
  }

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new BadRequestException('Webhook URL host is not permitted');
  }

  // Strip IPv6 brackets for isIP.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const family = isIP(bare);
  if (family && isPrivateAddress(bare, family)) {
    throw new BadRequestException('Webhook URL host is not permitted');
  }
}

function isPrivateAddress(addr: string, family: number): boolean {
  if (family === 6) {
    const a = addr.toLowerCase();
    if (a === '::1' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80')) {
      return true;
    }
    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1). The URL parser normalizes the
    // trailing v4 part to hex groups (::ffff:7f00:1), so expand the address
    // to 8 hextets and pull the embedded IPv4 out of the last 32 bits rather
    // than string-matching a dotted quad.
    const mapped = extractIPv4MappedAddress(a);
    if (mapped) return isPrivateAddress(mapped, 4);
    return false;
  }
  const parts = addr.split('.').map((n) => Number.parseInt(n, 10));
  const o0 = parts[0];
  const o1 = parts[1];
  if (o0 === 0) return true; // 0.0.0.0/8 — "this network" / unspecified
  if (o0 === 10 || o0 === 127) return true;
  if (o0 === 169 && o1 === 254) return true; // link-local + 169.254.169.254 metadata
  if (o0 === 192 && o1 === 168) return true;
  if (o0 === 172 && o1 !== undefined && o1 >= 16 && o1 <= 31) return true;
  return false;
}

/** Expand a valid IPv6 literal to its 8 hextets, handling `::` compression. */
function expandIPv6Hextets(addr: string): number[] | null {
  const [headStr, tailStr] = addr.includes('::') ? addr.split('::') : [addr, undefined];
  const head = headStr ? headStr.split(':') : [];
  const tail = tailStr !== undefined && tailStr !== '' ? tailStr.split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const zeros: string[] = new Array<string>(missing).fill('0');
  const groups = [...head, ...zeros, ...tail];
  if (groups.length !== 8) return null;
  const hextets = groups.map((g) => Number.parseInt(g === '' ? '0' : g, 16));
  return hextets.some((n) => Number.isNaN(n)) ? null : hextets;
}

/** If `addr` is an IPv4-mapped IPv6 literal, return the embedded IPv4 dotted quad. */
function extractIPv4MappedAddress(addr: string): string | null {
  const hextets = expandIPv6Hextets(addr);
  if (!hextets) return null;
  const isMapped = hextets.slice(0, 5).every((n) => n === 0) && hextets[5] === 0xffff;
  if (!isMapped) return null;
  const last32 = ((hextets[6] ?? 0) << 16) | (hextets[7] ?? 0);
  const b0 = (last32 >>> 24) & 0xff;
  const b1 = (last32 >>> 16) & 0xff;
  const b2 = (last32 >>> 8) & 0xff;
  const b3 = last32 & 0xff;
  return `${b0}.${b1}.${b2}.${b3}`;
}
