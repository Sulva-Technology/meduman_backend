import { resolve } from 'node:path';
import { config } from 'dotenv';

/**
 * Load `.env.test` before the specs import AppModule, whose zod schema validates
 * the environment at import time. Points at the docker-compose Postgres/Redis —
 * see `docker-compose.yml`. Existing process env wins, so CI can override any
 * single value (notably DATABASE_URL) without editing the file.
 */
config({ path: resolve(__dirname, '..', '.env.test') });
