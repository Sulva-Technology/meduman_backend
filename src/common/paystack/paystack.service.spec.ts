import { createHmac } from 'node:crypto';
import { BadGatewayException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.validation';
import { PaystackService } from './paystack.service';

const SECRET = 'sk_test_secret';

function makeConfig(): ConfigService<Env, true> {
  const values: Partial<Env> = {
    PAYSTACK_SECRET_KEY: SECRET,
    PAYSTACK_BASE_URL: 'https://api.paystack.co',
  };
  return {
    get: (key: keyof Env) => values[key],
  } as unknown as ConfigService<Env, true>;
}

function mockFetchOnce(body: unknown, ok = true, statusCode = 200) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok,
    status: statusCode,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
  global.fetch = fetchMock;
  return fetchMock;
}

afterEach(() => jest.restoreAllMocks());

describe('PaystackService.verifyWebhookSignature', () => {
  const service = new PaystackService(makeConfig());
  const rawBody = Buffer.from(
    JSON.stringify({ event: 'charge.success', data: { reference: 'r1' } }),
  );

  it('accepts a signature computed with the secret key over the exact raw body', () => {
    const sig = createHmac('sha512', SECRET).update(rawBody).digest('hex');
    expect(service.verifyWebhookSignature(rawBody, sig)).toBe(true);
  });

  it('rejects a signature over a tampered body', () => {
    const sig = createHmac('sha512', SECRET).update(rawBody).digest('hex');
    const tampered = Buffer.from(
      JSON.stringify({ event: 'charge.success', data: { reference: 'r2' } }),
    );
    expect(service.verifyWebhookSignature(tampered, sig)).toBe(false);
  });

  it('rejects a missing or malformed signature without throwing', () => {
    expect(service.verifyWebhookSignature(rawBody, '')).toBe(false);
    expect(service.verifyWebhookSignature(rawBody, 'deadbeef')).toBe(false);
  });
});

describe('PaystackService.initializeTransaction', () => {
  it('never sends a subaccount, even when one is smuggled into the input (decision D-2)', async () => {
    // A subaccount at collection time split-settles the seller's share directly,
    // so the platform never holds the funds — that defeats the whole product.
    // The charge payload must not carry one under any circumstance.
    const fetchMock = mockFetchOnce({
      status: true,
      data: { authorization_url: 'https://pay/x', access_code: 'ac_1', reference: 'ref_1' },
    });
    const service = new PaystackService(makeConfig());

    await service.initializeTransaction({
      email: 'buyer@example.com',
      amount: 125000,
      reference: 'ref_1',
      subaccount: 'ACCT_seller_1',
    } as Parameters<PaystackService['initializeTransaction']>[0]);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('subaccount');
  });

  it('POSTs to /transaction/initialize with bearer auth and maps the result', async () => {
    const fetchMock = mockFetchOnce({
      status: true,
      data: { authorization_url: 'https://pay/x', access_code: 'ac_1', reference: 'ref_1' },
    });
    const service = new PaystackService(makeConfig());

    const result = await service.initializeTransaction({
      email: 'buyer@example.com',
      amount: 125000,
      reference: 'ref_1',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.paystack.co/transaction/initialize');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(String(init.body))).toEqual(
      expect.objectContaining({ email: 'buyer@example.com', amount: 125000, reference: 'ref_1' }),
    );
    expect(result).toEqual({
      authorizationUrl: 'https://pay/x',
      accessCode: 'ac_1',
      reference: 'ref_1',
    });
  });
});

describe('PaystackService.verifyTransaction', () => {
  it('GETs /transaction/verify/:reference and returns the kobo amount and status', async () => {
    const fetchMock = mockFetchOnce({
      status: true,
      data: {
        status: 'success',
        amount: 125000,
        reference: 'ref_1',
        paid_at: '2026-07-28T00:00:00Z',
      },
    });
    const service = new PaystackService(makeConfig());

    const result = await service.verifyTransaction('ref_1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.paystack.co/transaction/verify/ref_1');
    expect(init.method).toBe('GET');
    expect(result).toEqual(
      expect.objectContaining({ status: 'success', amount: 125000, reference: 'ref_1' }),
    );
  });
});

describe('PaystackService error handling', () => {
  it('throws BadGatewayException when Paystack returns status:false', async () => {
    mockFetchOnce({ status: false, message: 'Invalid key' });
    const service = new PaystackService(makeConfig());

    await expect(service.verifyTransaction('ref_x')).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('throws BadGatewayException on a non-2xx HTTP response', async () => {
    mockFetchOnce({ message: 'nope' }, false, 500);
    const service = new PaystackService(makeConfig());

    await expect(service.verifyTransaction('ref_x')).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('PaystackService.initiateTransfer', () => {
  it('POSTs to /transfer and maps transfer_code', async () => {
    const fetchMock = mockFetchOnce({
      status: true,
      data: { transfer_code: 'trf_1', status: 'otp', reference: 'po_1' },
    });
    const service = new PaystackService(makeConfig());

    const result = await service.initiateTransfer({
      amount: 120000,
      recipient: 'RCP_1',
      reference: 'po_1',
      reason: 'release tx-1',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.paystack.co/transfer');
    expect(result).toEqual({ transferCode: 'trf_1', status: 'otp', reference: 'po_1' });
  });
});

describe('PaystackService.verifyTransfer', () => {
  it('GETs /transfer/verify/:reference and maps the transfer code', async () => {
    const fetchMock = mockFetchOnce({
      status: true,
      data: { transfer_code: 'TRF_1', status: 'success', reference: 'release:tx-1' },
    });
    const service = new PaystackService(makeConfig());

    const result = await service.verifyTransfer('release:tx-1');

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.paystack.co/transfer/verify/release%3Atx-1',
    );
    expect(result).toEqual({ transferCode: 'TRF_1', status: 'success' });
  });

  it('returns null when no transfer exists for the reference, instead of throwing', async () => {
    mockFetchOnce({ status: false, message: 'Transfer not found' }, false, 404);
    const service = new PaystackService(makeConfig());

    await expect(service.verifyTransfer('release:tx-missing')).resolves.toBeNull();
  });
});

describe('PaystackService.resolveAccount', () => {
  it('GETs /bank/resolve with the account and bank code, and maps account_name', async () => {
    const fetchMock = mockFetchOnce({
      status: true,
      data: { account_number: '0123456789', account_name: 'ADA OKAFOR' },
    });
    const service = new PaystackService(makeConfig());

    const result = await service.resolveAccount({
      accountNumber: '0123456789',
      bankCode: '058',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.paystack.co/bank/resolve?account_number=0123456789&bank_code=058',
    );
    expect(init.method).toBe('GET');
    expect(result).toEqual({ accountName: 'ADA OKAFOR', accountNumber: '0123456789' });
  });
});

describe('PaystackService.createTransferRecipient', () => {
  it('POSTs a NUBAN recipient to /transferrecipient and maps recipient_code', async () => {
    const fetchMock = mockFetchOnce({
      status: true,
      data: { recipient_code: 'RCP_1', active: true },
    });
    const service = new PaystackService(makeConfig());

    const result = await service.createTransferRecipient({
      name: 'ADA OKAFOR',
      accountNumber: '0123456789',
      bankCode: '058',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.paystack.co/transferrecipient');
    expect(JSON.parse(String(init.body))).toEqual({
      type: 'nuban',
      name: 'ADA OKAFOR',
      account_number: '0123456789',
      bank_code: '058',
      currency: 'NGN',
    });
    expect(result).toEqual({ recipientCode: 'RCP_1' });
  });
});

describe('PaystackService.listBanks', () => {
  it('GETs /bank for NGN and maps name/code pairs', async () => {
    const fetchMock = mockFetchOnce({
      status: true,
      data: [
        { name: 'Access Bank', code: '044', active: true },
        { name: 'GTBank', code: '058', active: true },
      ],
    });
    const service = new PaystackService(makeConfig());

    const result = await service.listBanks();

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.paystack.co/bank?currency=NGN');
    expect(result).toEqual([
      { name: 'Access Bank', code: '044' },
      { name: 'GTBank', code: '058' },
    ]);
  });
});

describe('PaystackService.createSubaccount', () => {
  it('POSTs to /subaccount and maps subaccount_code', async () => {
    const fetchMock = mockFetchOnce({ status: true, data: { subaccount_code: 'ACCT_1' } });
    const service = new PaystackService(makeConfig());

    const result = await service.createSubaccount({
      businessName: 'Ada Stores',
      settlementBank: '058',
      accountNumber: '0123456789',
      percentageCharge: 2.5,
    });

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.paystack.co/subaccount');
    expect(result).toEqual({ subaccountCode: 'ACCT_1' });
  });
});
