import type { SdkModule } from "../audit.ts";
import { SECRET_KEY_PATTERN, WEBHOOK_SECRET_PATTERN } from "./stripe.ts";

export const clerkModule: SdkModule = {
  name: "clerk",
  packages: ["@clerk/*"],
  serverPackages: ["@clerk/backend", "@clerk/express", "@clerk/fastify", "@clerk/types", "@clerk/testing", "@clerk/dev-cli"],
  secretEnvNames: ["CLERK_SECRET_KEY", "CLERK_WEBHOOK_SIGNING_SECRET", "CLERK_WEBHOOK_SECRET"],
  secretLiterals: [SECRET_KEY_PATTERN, WEBHOOK_SECRET_PATTERN],
};
