import { createClient, type SupabaseClient } from "@supabase/supabase-js";

declare global {
  // eslint-disable-next-line no-var
  var supabaseAdminGlobal: SupabaseClient | undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Add it to .env`);
  }
  return value;
}

export function getSupabaseAdmin(): SupabaseClient {
  if (!global.supabaseAdminGlobal) {
    global.supabaseAdminGlobal = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      },
    );
  }

  return global.supabaseAdminGlobal;
}

export function getSupabaseAnon(): SupabaseClient {
  return createClient(
    requireEnv("SUPABASE_URL"),
    process.env.SUPABASE_ANON_KEY || requireEnv("SUPABASE_PUBLISHABLE_KEY"),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}
