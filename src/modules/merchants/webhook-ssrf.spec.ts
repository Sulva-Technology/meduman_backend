import { BadRequestException } from '@nestjs/common';
import { assertPublicUrl } from './webhook-ssrf';

describe('assertPublicUrl', () => {
  it('allows a normal https URL', () => {
    expect(() =>
      assertPublicUrl('https://hooks.example.com/x', { allowHttp: false }),
    ).not.toThrow();
  });

  it('rejects http when allowHttp is false, allows it when true', () => {
    expect(() => assertPublicUrl('http://hooks.example.com', { allowHttp: false })).toThrow(
      BadRequestException,
    );
    expect(() => assertPublicUrl('http://hooks.example.com', { allowHttp: true })).not.toThrow();
  });

  it('rejects loopback, private, link-local, and metadata hosts', () => {
    for (const url of [
      'https://127.0.0.1/x',
      'https://localhost/x',
      'http://10.0.0.5/x',
      'http://192.168.1.1/x',
      'http://172.16.0.1/x',
      'http://169.254.169.254/latest/meta-data',
      'https://[::1]/x',
    ]) {
      expect(() => assertPublicUrl(url, { allowHttp: true })).toThrow(BadRequestException);
    }
  });

  it('rejects 0.0.0.0 and IPv4-mapped IPv6 private addresses', () => {
    for (const url of [
      'https://0.0.0.0/x',
      'http://0.0.0.0:6379/',
      'https://[::ffff:127.0.0.1]/x',
      'https://[::ffff:169.254.169.254]/',
    ]) {
      expect(() => assertPublicUrl(url, { allowHttp: true })).toThrow(BadRequestException);
    }
  });

  it('rejects a non-URL', () => {
    expect(() => assertPublicUrl('not a url', { allowHttp: true })).toThrow(BadRequestException);
  });
});
