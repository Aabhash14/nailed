import type { SupabaseClient } from "@supabase/supabase-js";

/** Loosely typed Supabase client; results are cast to the row types in src/types/db.ts. */
export type Db = SupabaseClient;
