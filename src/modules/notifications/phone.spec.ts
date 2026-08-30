import { UnroutablePhoneNumberError, maskRecipient, normalizeMsisdn } from './phone';

describe('normalizeMsisdn (Nigerian shapes)', () => {
  it('normalizes the national trunk form 0803...', () => {
    expect(normalizeMsisdn('08031234567')).toBe('2348031234567');
  });

  it('normalizes the +234 international form', () => {
    expect(normalizeMsisdn('+2348031234567')).toBe('2348031234567');
  });

  it('normalizes the bare 234 form (already E.164 without the plus)', () => {
    expect(normalizeMsisdn('2348031234567')).toBe('2348031234567');
  });

  it('normalizes the bare national significant number 803...', () => {
    expect(normalizeMsisdn('8031234567')).toBe('2348031234567');
  });

  it('strips punctuation and the 00 international prefix', () => {
    expect(normalizeMsisdn('+234 (803) 123-4567')).toBe('2348031234567');
    expect(normalizeMsisdn('002348031234567')).toBe('2348031234567');
  });

  it('honours a non-Nigerian default country code', () => {
    expect(normalizeMsisdn('07911123456', '44')).toBe('447911123456');
  });
});

describe('normalizeMsisdn (rejections)', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['not-a-number', 'letters'],
    ['buyer@example.com', 'an email address'],
    ['+08031234567', 'a plus with a trunk zero'],
    ['23480312345678', 'a too-long Nigerian number'],
    ['2348031234', 'a too-short Nigerian number'],
    ['12345', 'far too few digits'],
    ['1234567890123456', 'more than 15 digits'],
  ])('rejects %p (%s)', (input) => {
    expect(() => normalizeMsisdn(input)).toThrow(UnroutablePhoneNumberError);
  });

  it('never puts the offending number in the error message', () => {
    try {
      normalizeMsisdn('23480312345678');
      throw new Error('expected a rejection');
    } catch (err) {
      expect((err as Error).message).not.toContain('23480312345678');
    }
  });
});

describe('maskRecipient', () => {
  it('keeps only the last 4 characters', () => {
    expect(maskRecipient('2348031234567')).toBe('*********4567');
    expect(maskRecipient('123')).toBe('****');
  });
});
