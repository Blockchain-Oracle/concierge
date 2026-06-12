import { ConciergeError } from '@concierge/sdk';
import { toTimestampPolicy } from '@zerodev/permissions/policies';

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
/**
 * Maximum delta between `now` and `validAfter` when `validUntil` is unspecified.
 * Catches the millisecond-vs-seconds misuse: `validAfter: Date.now()` (ms,
 * ~1.7e12) is a valid uint48 integer until year ~58085, so it would silently
 * pass the uint48 bound and produce a default `validUntil` 7 days after that.
 * Capping at 1 year forces the caller to either pass seconds or explicitly
 * acknowledge the long-lived intent by also setting `validUntil`.
 */
const MAX_FUTURE_VALID_AFTER_WITHOUT_VALID_UNTIL = 365 * 24 * 60 * 60;
/** uint48 max — ZeroDev timestamp policy encodes both bounds as uint48 seconds. */
const UINT48_MAX = 281_474_976_710_655;

/**
 * **Spec drift (audit §19):** Story-52 called this "TimeFramePolicy". ZeroDev's
 * actual export is `toTimestampPolicy`. Behaviour is identical (validAfter +
 * validUntil uint48 seconds) — we just wrap with friendlier defaults +
 * non-zero + uint48-bounds validation. "TimeFrame" naming retained on our public
 * surface to match the story spec.
 */
export interface CreateTimeFramePolicyConfig {
  /** Unix SECONDS — session key invalid AFTER this. Default = now + 7 days. */
  readonly validUntil?: number;
  /** Unix SECONDS — session key invalid BEFORE this. Default = now. */
  readonly validAfter?: number;
}

function assertUnixSeconds(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT48_MAX) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] createTimeFramePolicy: InvalidPolicy: ${name} (${value}) must be an integer in [0, 2^48-1] Unix SECONDS. (Did you pass milliseconds?)`,
    );
  }
}

export function createTimeFramePolicy(
  config: CreateTimeFramePolicyConfig,
): ReturnType<typeof toTimestampPolicy> {
  const now = Math.floor(Date.now() / 1000);
  const validAfter = config.validAfter ?? now;
  // Run uint48/integer bound first so overflow paths get the more-specific message.
  assertUnixSeconds('validAfter', validAfter);
  if (config.validUntil !== undefined) assertUnixSeconds('validUntil', config.validUntil);
  // Catch the millisecond-vs-seconds misuse before defaulting validUntil: a
  // caller passing a valid-uint48 but-far-future validAfter (e.g. Date.now()/1
  // by accident — though that overflows above; or any sub-uint48 mistake) with
  // an unspecified validUntil would silently get a 7-day window decades out.
  if (
    config.validUntil === undefined &&
    config.validAfter !== undefined &&
    validAfter > now + MAX_FUTURE_VALID_AFTER_WITHOUT_VALID_UNTIL
  ) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] createTimeFramePolicy: InvalidPolicy: validAfter (${validAfter}) is more than 1 year in the future and validUntil is unspecified. (Did you pass milliseconds? expected Unix SECONDS.) Pass validUntil explicitly to confirm long-lived intent.`,
    );
  }
  // When validUntil is unset but the caller pinned validAfter in the near future,
  // default to "7 days after the later of (now, validAfter)" so we don't throw
  // a misleading "validUntil <= validAfter" error on an input the caller never set.
  const validUntil = config.validUntil ?? Math.max(validAfter, now) + SEVEN_DAYS_SECONDS;
  // Re-check defaulted validUntil — assertUnixSeconds already ran on caller-supplied validUntil above.
  assertUnixSeconds('validUntil', validUntil);
  if (validUntil === 0) {
    throw new ConciergeError(
      'ConfigError',
      '[@concierge/smart-account] createTimeFramePolicy: InvalidPolicy: validUntil=0 means "no expiry" — session keys must have a finite lifetime.',
    );
  }
  if (validUntil <= validAfter) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] createTimeFramePolicy: InvalidPolicy: validUntil (${validUntil}) must be > validAfter (${validAfter}).`,
    );
  }
  return toTimestampPolicy({ validAfter, validUntil });
}
