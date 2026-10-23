/**
 * Keep secrets out of what a client prints of itself.
 *
 * Mirrors the Python SDK's `mask`: a secret keeps only its kind (`bk_live_`)
 * and at most its last four characters (`bk_live_...a1b2`). A short secret is
 * masked whole.
 */

/** Prefixes of Beakr secrets; kept in a masked value because they name its kind. */
const SECRET_PREFIXES = ["bk_live_", "bk_test_", "bk_at_", "bk_rt_"] as const;

/** A secret shorter than this past its prefix is masked whole. */
const MIN_TAIL_LENGTH = 16;

/** `bk_live_...a1b2` for `bk_live_<secret>a1b2`; `undefined` and `""` unchanged. */
export function maskSecret(secret: string | undefined): string | undefined {
  if (!secret) return secret;
  const prefix = SECRET_PREFIXES.find((candidate) => secret.startsWith(candidate)) ?? "";
  const body = secret.slice(prefix.length);
  if (body.length < MIN_TAIL_LENGTH) return `${prefix}***`;
  return `${prefix}...${body.slice(-4)}`;
}
