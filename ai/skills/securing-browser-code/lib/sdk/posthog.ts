import type { SdkModule } from "../audit.ts";

export const posthogModule: SdkModule = {
  name: "posthog",
  packages: ["posthog-js", "@posthog/react", "@posthog/nuxt"],
  secretEnvNames: [],
  secretLiterals: [],
};
