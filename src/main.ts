import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { AppModule } from './app.module';
import type { Env } from './config/env.validation';
import { initSentry } from './observability/sentry';

/**
 * API web service entrypoint (Render web service).
 * Raw body is preserved for webhook signature verification.
 */
async function bootstrap(): Promise<void> {
  initSentry({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV });

  const app = await NestFactory.create(AppModule, {
    // Keep the raw request body so Paystack webhook HMAC can be verified.
    rawBody: true,
    // Buffer early logs until the pino logger is attached below.
    bufferLogs: true,
  });
  // Use pino as the application logger (structured JSON + redaction).
  app.useLogger(app.get(Logger));

  const config: ConfigService<Env, true> = app.get(ConfigService);
  const port = config.get('PORT', { infer: true });
  const origins = config
    .get('FRONTEND_ORIGIN', { infer: true })
    .split(',')
    .map((o) => o.trim());

  app.use(helmet());
  app.enableCors({ origin: origins, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableShutdownHooks();

  await app.listen(port);
  app.get(Logger).log(`API listening on :${port}`);
}

void bootstrap();
