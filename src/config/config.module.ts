import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validateEnv } from './env.validation';

/**
 * Global config module. Validates the environment at boot (fail-fast) and
 * exposes the typed ConfigService everywhere.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
  ],
})
export class AppConfigModule {}
