/**
 * Pure phone-number helpers for outbound transports. No Nest, no I/O — the
 * normalizer is the only thing standing between a badly-shaped stored number and
 * an OTP delivered to a stranger, so it is deliberately strict and unit-tested.
 */

/** E.164 allows 15 digits max (country code included); 8 is a sane floor. */
const MIN_E164_DIGITS = 8;
const MAX_E164_DIGITS = 15;

/** Nigerian mobile national significant numbers are 10 digits and start 7/8/9. */
const NG_COUNTRY_CODE = '234';
const NG_NSN_LENGTH = 10;
const NG_MSISDN_LENGTH = NG_COUNTRY_CODE.length + NG_NSN_LENGTH; // 13

/**
 * A recipient we refuse to dial. The message NEVER contains the number itself
 * (it lands in logs, BullMQ `failedReason` and Sentry) — only why it failed.
 */
export class UnroutablePhoneNumberError extends Error {
  constructor(reason: string) {
    super(`Unroutable phone number: ${reason}`);
    this.name = 'UnroutablePhoneNumberError';
  }
}

/** Mask all but the last 4 chars of a recipient for safe logging. */
export function maskRecipient(to: string): string {
  return to.length <= 4 ? '****' : `${'*'.repeat(to.length - 4)}${to.slice(-4)}`;
}

/**
 * Normalize a stored phone number to the shape WhatsApp wants: E.164 digits with
 * NO leading `+`. Handles the three shapes Nigerian numbers actually arrive in
 * (`0803...`, `+234803...`, `234803...`) plus the bare national `803...` form and
 * the `00`-prefixed international form. Anything it cannot map with certainty
 * throws {@link UnroutablePhoneNumberError} rather than guessing — sending an OTP
 * to the wrong handset is worse than not sending it.
 */
export function normalizeMsisdn(raw: string, defaultCountryCode: string = NG_COUNTRY_CODE): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new UnroutablePhoneNumberError('empty');
  // Reject anything that is not plausibly a phone number BEFORE stripping, so an
  // email address or free text can never be squeezed into digits and dialed.
  if (!/^\+?[0-9\s().-]+$/.test(trimmed)) {
    throw new UnroutablePhoneNumberError('contains non-dialable characters');
  }

  const hadPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/[^0-9]/g, '');
  if (!digits) throw new UnroutablePhoneNumberError('no digits');

  // `00` is the international access prefix — equivalent to a leading `+`.
  if (!hadPlus && digits.startsWith('00')) digits = digits.slice(2);

  if (digits.startsWith('0')) {
    // A `+0...` number does not exist; only a national trunk form starts with 0.
    if (hadPlus) throw new UnroutablePhoneNumberError('invalid country code');
    digits = `${defaultCountryCode}${digits.replace(/^0+/, '')}`;
  } else if (
    defaultCountryCode === NG_COUNTRY_CODE &&
    digits.length === NG_NSN_LENGTH &&
    /^[789]/.test(digits)
  ) {
    // Bare national significant number (`8031234567`) — NG mobile, no trunk zero.
    digits = `${NG_COUNTRY_CODE}${digits}`;
  }

  // +234 is Nigeria and nothing else, so its length is exactly known: catch
  // double-trunk garbage like `2340803...` instead of dialing it.
  if (digits.startsWith(NG_COUNTRY_CODE) && digits.length !== NG_MSISDN_LENGTH) {
    throw new UnroutablePhoneNumberError('malformed Nigerian number');
  }
  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) {
    throw new UnroutablePhoneNumberError('wrong length for E.164');
  }
  return digits;
}
