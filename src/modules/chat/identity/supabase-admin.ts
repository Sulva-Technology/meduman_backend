/** DI token for the Supabase admin auth client (service-role key). */
export const SUPABASE_ADMIN_CLIENT = Symbol('SUPABASE_ADMIN_CLIENT');

/** Minimal Supabase Auth admin surface ChatIdentityService depends on (testable seam). */
export interface SupabaseAdminCreateUserResult {
  data: { user: { id: string } | null } | null;
  error: { message: string } | null;
}

export interface SupabaseAdminAuthClient {
  auth: {
    admin: {
      createUser(attrs: {
        email: string;
        email_confirm?: boolean;
        phone?: string;
        user_metadata?: Record<string, unknown>;
      }): Promise<SupabaseAdminCreateUserResult>;
    };
  };
}
