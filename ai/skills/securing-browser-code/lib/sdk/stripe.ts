import type { SdkModule } from "../audit.ts";

export const SECRET_KEY_PATTERN = /\bsk_(?:live|test)_[0-9A-Za-z]{24,}/;
export const WEBHOOK_SECRET_PATTERN = /\bwhsec_[0-9A-Za-z+/]{24,}/;

export const stripeModule: SdkModule = {
  name: "stripe",
  packages: ["@stripe/stripe-js", "@stripe/react-stripe-js"],
  secretEnvNames: ["STRIPE_SECRET_KEY", "STRIPE_RESTRICTED_KEY", "STRIPE_WEBHOOK_SECRET"],
  secretLiterals: [SECRET_KEY_PATTERN, /\brk_(?:live|test)_[0-9A-Za-z]{24,}/, WEBHOOK_SECRET_PATTERN],
};
