import type { SdkModule } from "../audit.ts";

const SERVICE_ROLE_PAYLOAD_MARKERS = ["InJvbGUiOiJzZXJ2aWNlX3JvbGU", "yb2xlIjoic2VydmljZV9yb2xl", "cm9sZSI6InNlcnZpY2Vfcm9sZ"];

export const supabaseModule: SdkModule = {
  name: "supabase",
  packages: ["@supabase/supabase-js", "@supabase/ssr"],
  secretEnvNames: ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"],
  secretLiterals: [
    /\bsb_secret_[0-9A-Za-z_-]{20,}/,
    new RegExp(`(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*(?:${SERVICE_ROLE_PAYLOAD_MARKERS.join("|")})[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]+`),
  ],
};
