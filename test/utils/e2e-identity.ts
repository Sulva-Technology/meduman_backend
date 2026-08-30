/**
 * Auth-header helpers, kept free of any AppModule import so the spec can import
 * them at top level without triggering env validation (which runs at ConfigModule
 * import time). The heavy harness that imports AppModule is loaded lazily.
 */

/** Header-driven identity — the e2e auth guard reads these instead of a real JWT. */
export interface TestIdentity {
  sub: string;
  email?: string;
  appRole?: string;
}

/** Build request headers that the overridden guard turns into `request.user`. */
export function authHeaders(id: TestIdentity): Record<string, string> {
  return {
    'x-test-sub': id.sub,
    ...(id.email ? { 'x-test-email': id.email } : {}),
    ...(id.appRole ? { 'x-test-role': id.appRole } : {}),
  };
}
