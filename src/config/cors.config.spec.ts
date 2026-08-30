import { Controller, Get, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { buildCorsOptions } from './cors.config';

@Controller('users')
class ProtectedTestController {
  @Get('me')
  me(): never {
    throw new UnauthorizedException('Missing bearer token');
  }
}

describe('production browser access', () => {
  let app: INestApplication<Server>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProtectedTestController],
    }).compile();
    app = moduleRef.createNestApplication();
    // Reproduce a stale Render setting that omits the production frontend.
    app.enableCors(
      buildCorsOptions('http://localhost:3001, https://preview.example.com/ ', 'production'),
    );
    await app.init();
  });

  afterAll(async () => app.close());

  it('allows the production bearer-token preflight', async () => {
    const response = await request(app.getHttpServer())
      .options('/users/me')
      .set('Origin', 'https://meduman.sulvatech.com')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization,content-type')
      .expect(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://meduman.sulvatech.com');
    expect(response.headers['access-control-allow-headers']).toBe('authorization,content-type');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('exposes authentication errors without bypassing authentication', async () => {
    const response = await request(app.getHttpServer())
      .get('/users/me')
      .set('Origin', 'https://meduman.sulvatech.com')
      .expect(401);
    expect(response.headers['access-control-allow-origin']).toBe('https://meduman.sulvatech.com');
  });

  it.each(['https://untrusted.example', 'https://meduman.sulvatech.com.evil.example', 'null'])(
    'does not grant browser access to %s',
    async (origin) => {
      const response = await request(app.getHttpServer())
        .options('/users/me')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'GET');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    },
  );

  it('preserves configured origins and normalizes a trailing slash', async () => {
    const response = await request(app.getHttpServer())
      .get('/users/me')
      .set('Origin', 'https://preview.example.com')
      .expect(401);
    expect(response.headers['access-control-allow-origin']).toBe('https://preview.example.com');
  });

  it('keeps development origins controlled by the local configuration', () => {
    expect(
      buildCorsOptions(' http://localhost:3001/, ,http://localhost:3001 ', 'development'),
    ).toEqual({ origin: ['http://localhost:3001'], credentials: true });
  });
});
