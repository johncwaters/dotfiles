import type { SdkModule } from "../audit.ts";

export const convexModule: SdkModule = {
  name: "convex",
  packages: ["convex"],
  secretEnvNames: ["CONVEX_DEPLOY_KEY"],
  secretLiterals: [],
};
