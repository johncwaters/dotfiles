export const EXIT_CODES = {
  PUBLISHED: 0,
  ARGS_INVALID: 40,
  PROFILE_INVALID: 41,
  BRANCH_NOT_ALLOWED: 42,
  TAG_INVALID: 43,
  TAG_NOT_ON_RELEASE_TIP: 44,
  PUSH_REJECTED: 45,
  PUSH_FAILED: 46,
} as const;

export type OutcomeName = keyof typeof EXIT_CODES;

export function emit(outcome: OutcomeName, fields: Record<string, unknown> = {}): never {
  process.stdout.write(`${JSON.stringify({ outcome, ...fields })}\n`);
  process.exit(EXIT_CODES[outcome]);
}
