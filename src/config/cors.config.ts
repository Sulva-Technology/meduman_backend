import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

// The deployed first-party frontend must remain reachable even when Render's
// extra-origin setting still contains a development URL or the old domain.
const PRODUCTION_FRONTEND_ORIGIN = 'https://meduman.sulvatech.com';

export function buildCorsOptions(frontendOrigin: string, nodeEnv: string): CorsOptions {
  const origins = frontendOrigin
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  if (nodeEnv === 'production') origins.push(PRODUCTION_FRONTEND_ORIGIN);

  return { origin: [...new Set(origins)], credentials: true };
}
