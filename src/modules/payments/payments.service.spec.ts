import { NotFoundException } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import type { PrismaService } from '@/prisma/prisma.service';
import type { PaystackService } from '@/common/paystack';
import type { TransactionsService } from '@/modules/transactions/transactions.service';
import type { QueueService } from '@/modules/queue/queue.service';
import type { InvoicesService } from '@/modules/invoices/invoices.service';
import { PaymentsService } from './payments.service';
import { AmountMismatchError } from './amount-mismatch.error';

const APP_URL = 'https://api.meduman.test';

function makeConfig() {
  return { get: () => APP_URL } as never;
}

const txRow = {
  id: 'tx-1',
  status: 'LINK_ACTIVE',
  amount: 125000,
  currency: 'NGN',
  feeModel: 'BUYER_PAYS',
  feeAmount: 2500,
  buyerId: null,
};

function makeDeps(
  overrides: {
    tx?: Record<string, unknown> | null;
    payment?: Record<string, unknown> | null;
  } = {},
) {
  const txFindUnique = jest
    .fn()
    .mockResolvedValue(overrides.tx === undefined ? txRow : overrides.tx);
  const txUpdate = jest.fn().mockResolvedValue({});
  const paymentCreate = jest
    .fn()
    .mockImplementation(({ data }) => Promise.resolve({ id: 'pay-1', ...data }));
  const paymentFindUnique = jest
    .fn()
    .mockResolvedValue(overrides.payment === undefined ? null : overrides.payment);
  const paymentUpdate = jest
    .fn()
    .mockImplementation(({ data }) => Promise.resolve({ id: 'pay-1', ...data }));

  const paymentFindFirst = jest.fn().mockResolvedValue(null);
  const paymentUpdateMany = jest.fn().mockResolvedValue({ count: 1 });

  const prisma = {
    transaction: { findUnique: txFindUnique, update: txUpdate },
    payment: {
      create: paymentCreate,
      findUnique: paymentFindUnique,
      findFirst: paymentFindFirst,
      update: paymentUpdate,
      updateMany: paymentUpdateMany,
    },
  } as unknown as PrismaService;

  const initializeTransaction = jest.fn().mockResolvedValue({
    authorizationUrl: 'https://checkout.paystack/x',
    accessCode: 'ac_1',
    reference: 'ignored',
  });
  const verifyTransaction = jest.fn();
  const paystack = { initializeTransaction, verifyTransaction } as unknown as PaystackService;

  const apply = jest.fn().mockResolvedValue({ id: 'tx-1', status: 'PAYMENT_PROTECTED' });
  const transactions = { apply } as unknown as TransactionsService;

  const createCustomer = jest.fn().mockResolvedValue({ customerCode: 'CUS_1' });
  const createDedicatedAccount = jest
    .fn()
    .mockResolvedValue({ accountNumber: null, bankName: null, dedicatedAccountId: null });
  (paystack as unknown as Record<string, unknown>).createCustomer = createCustomer;
  (paystack as unknown as Record<string, unknown>).createDedicatedAccount = createDedicatedAccount;

  const enqueueChatOutbound = jest.fn().mockResolvedValue(undefined);
  const queue = { enqueueChatOutbound } as unknown as QueueService;

  const markPaidByTransaction = jest.fn().mockResolvedValue(undefined);
  const invoices = { markPaidByTransaction } as unknown as InvoicesService;

  const service = new PaymentsService(
    prisma,
    paystack,
    transactions,
    queue,
    makeConfig(),
    invoices,
  );
  return {
    service,
    txFindUnique,
    txUpdate,
    paymentCreate,
    paymentUpdate,
    paymentFindFirst,
    paymentUpdateMany,
    paymentFindUnique,
    initializeTransaction,
    verifyTransaction,
    createCustomer,
    createDedicatedAccount,
    apply,
    enqueueChatOutbound,
  };
}

describe('PaymentsService.initializeCollection', () => {
  it('moves the transaction to PAYMENT_PENDING, creates a PENDING payment, and returns the checkout URL', async () => {
    const { service, paymentCreate, initializeTransaction, apply } = makeDeps();

    const result = await service.initializeCollection({
      transactionId: 'tx-1',
      buyerId: 'buyer-1',
      email: 'buyer@example.com',
    });

    // server owns the state change — driven through the machine, not a client status
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: 'tx-1',
        event: { type: 'BUYER_INITIATE_CHECKOUT' },
      }),
    );
    // payment persisted PENDING with a unique provider reference
    const createArg = paymentCreate.mock.calls[0][0].data;
    expect(createArg.status).toBe(PaymentStatus.PENDING);
    expect(typeof createArg.providerReference).toBe('string');
    expect(createArg.providerReference.length).toBeGreaterThan(0);
    // charge = amount + fee for BUYER_PAYS
    expect(createArg.amount).toBe(127500);
    // same reference and kobo amount are sent to Paystack
    const initArg = initializeTransaction.mock.calls[0][0];
    expect(initArg.amount).toBe(127500);
    expect(initArg.reference).toBe(createArg.providerReference);
    expect(result.authorizationUrl).toBe('https://checkout.paystack/x');
  });

  it('links the buyer to a transaction that has none yet', async () => {
    const { service, txUpdate } = makeDeps();

    await service.initializeCollection({
      transactionId: 'tx-1',
      buyerId: 'buyer-1',
      email: 'buyer@example.com',
    });

    expect(txUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { buyerId: 'buyer-1' } }),
    );
  });

  it('throws NotFound for an unknown transaction and never calls Paystack', async () => {
    const { service, initializeTransaction } = makeDeps({ tx: null });

    await expect(
      service.initializeCollection({ transactionId: 'nope', buyerId: 'b', email: 'e@x.com' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(initializeTransaction).not.toHaveBeenCalled();
  });

  it('resolves the transaction by publicLinkId for a shared-pay-link buyer (no internal id)', async () => {
    const { service, txFindUnique, paymentCreate } = makeDeps();

    const result = await service.initializeCollection({
      publicLinkId: 'link-abc',
      buyerId: 'buyer-1',
      email: 'buyer@example.com',
    });

    // looked up by the public link id, never by internal id
    expect(txFindUnique).toHaveBeenCalledWith({ where: { publicLinkId: 'link-abc' } });
    // and it drives the same protected-charge path
    expect(paymentCreate.mock.calls[0][0].data.amount).toBe(127500);
    expect(result.authorizationUrl).toBe('https://checkout.paystack/x');
  });

  it('throws NotFound for an unknown publicLinkId and never calls Paystack', async () => {
    const { service, initializeTransaction } = makeDeps({ tx: null });

    await expect(
      service.initializeCollection({ publicLinkId: 'nope', buyerId: 'b', email: 'e@x.com' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(initializeTransaction).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.verifyAndProtect', () => {
  const pendingPayment = {
    id: 'pay-1',
    providerReference: 'mdn_ref',
    transactionId: 'tx-1',
    amount: 127500,
    status: PaymentStatus.PENDING,
  };

  it('protects the transaction when Paystack confirms success and the amount matches', async () => {
    const { service, paymentUpdate, verifyTransaction, apply } = makeDeps({
      payment: pendingPayment,
    });
    verifyTransaction.mockResolvedValue({
      status: 'success',
      amount: 127500,
      reference: 'mdn_ref',
      paidAt: '2026-07-28T00:00:00Z',
      raw: { ok: true },
    });

    await service.verifyAndProtect('mdn_ref', 'SERVER_VERIFY');

    // payment marked SUCCESS
    expect(paymentUpdate.mock.calls[0][0].data.status).toBe(PaymentStatus.SUCCESS);
    // transaction driven to protected with the trusted source (money rule 2)
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: 'tx-1',
        event: { type: 'PAYMENT_VERIFIED', source: 'SERVER_VERIFY' },
      }),
    );
  });

  it('is idempotent — an already-SUCCESS payment does not re-verify or re-protect', async () => {
    const { service, verifyTransaction, apply } = makeDeps({
      payment: { ...pendingPayment, status: PaymentStatus.SUCCESS },
    });

    await service.verifyAndProtect('mdn_ref', 'WEBHOOK');

    expect(verifyTransaction).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('refuses to protect when the collected amount does not match the expected charge', async () => {
    const { service, verifyTransaction, apply } = makeDeps({ payment: pendingPayment });
    verifyTransaction.mockResolvedValue({
      status: 'success',
      amount: 100000, // underpaid
      reference: 'mdn_ref',
      paidAt: null,
      raw: {},
    });

    await expect(service.verifyAndProtect('mdn_ref', 'SERVER_VERIFY')).rejects.toBeInstanceOf(
      AmountMismatchError,
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it('does not protect when Paystack reports a non-success status', async () => {
    const { service, verifyTransaction, apply } = makeDeps({ payment: pendingPayment });
    verifyTransaction.mockResolvedValue({
      status: 'abandoned',
      amount: 127500,
      reference: 'mdn_ref',
      paidAt: null,
      raw: {},
    });

    await service.verifyAndProtect('mdn_ref', 'SERVER_VERIFY');

    expect(apply).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: expect.objectContaining({ type: 'PAYMENT_VERIFIED' }) }),
    );
  });

  it('throws NotFound for an unknown reference', async () => {
    const { service } = makeDeps({ payment: null });

    await expect(service.verifyAndProtect('missing', 'WEBHOOK')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('PaymentsService.handleChargeSuccess — dedicated virtual account', () => {
  const dvaPayment = {
    id: 'pay-dva',
    providerReference: 'mdn_dva_abc',
    providerChargeReference: null,
    providerCustomerCode: 'CUS_1',
    transactionId: 'tx-1',
    amount: 127500,
    status: PaymentStatus.PENDING,
  };

  // A DVA charge arrives with Paystack's OWN reference (not ours) + a customer
  // code, so the payment resolves by customer, binds the charge ref once, then
  // verifies against that ref.
  function makeDvaDeps(opts: {
    boundCount?: number;
    verifyAmount?: number;
    alreadyBound?: Record<string, unknown> | null;
    payment?: Record<string, unknown> | null;
  }) {
    const paymentFindUniqueByRef = jest.fn().mockResolvedValue(null); // hosted miss
    const paymentFindUniqueByChargeRef = jest.fn().mockResolvedValue(opts.alreadyBound ?? null);
    const paymentFindUniqueById = jest
      .fn()
      .mockResolvedValue(opts.payment === undefined ? { ...dvaPayment } : opts.payment);

    // findUnique dispatches by which key was queried.
    const findUnique = jest
      .fn()
      .mockImplementation((args: { where: Record<string, unknown> }): Promise<unknown> => {
        if ('providerReference' in args.where)
          return paymentFindUniqueByRef(args) as Promise<unknown>;
        if ('providerChargeReference' in args.where) {
          return paymentFindUniqueByChargeRef(args) as Promise<unknown>;
        }
        return paymentFindUniqueById(args) as Promise<unknown>;
      });

    const findFirst = jest
      .fn()
      .mockResolvedValue(opts.payment === undefined ? { ...dvaPayment } : opts.payment);
    const updateMany = jest.fn().mockResolvedValue({ count: opts.boundCount ?? 1 });
    const update = jest
      .fn()
      .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...dvaPayment, ...data }),
      );

    const txFindUnique = jest.fn().mockResolvedValue({
      id: 'tx-1',
      title: 'X',
      amount: 125000,
      sellerId: 'seller-1',
      buyerId: 'buyer-1',
    });

    const prisma = {
      transaction: { findUnique: txFindUnique },
      payment: { findUnique, findFirst, updateMany, update },
    } as unknown as PrismaService;

    const verifyTransaction = jest.fn().mockResolvedValue({
      status: 'success',
      amount: opts.verifyAmount ?? 127500,
      reference: 'PSTK_charge_ref',
      paidAt: '2026-08-02T00:00:00Z',
      raw: {},
    });
    const paystack = { verifyTransaction } as unknown as PaystackService;

    const apply = jest.fn().mockResolvedValue({});
    const transactions = { apply } as unknown as TransactionsService;
    const enqueueChatOutbound = jest.fn().mockResolvedValue(undefined);
    const queue = { enqueueChatOutbound } as unknown as QueueService;

    const markPaidByTransaction = jest.fn().mockResolvedValue(undefined);
    const invoices = { markPaidByTransaction } as unknown as InvoicesService;

    const service = new PaymentsService(
      prisma,
      paystack,
      transactions,
      queue,
      makeConfig(),
      invoices,
    );
    return { service, updateMany, verifyTransaction, apply };
  }

  it('resolves by customer code, binds Paystack reference once, and protects', async () => {
    const { service, updateMany, verifyTransaction, apply } = makeDvaDeps({});

    const handled = await service.handleChargeSuccess(
      { reference: 'PSTK_charge_ref', customerCode: 'CUS_1' },
      'WEBHOOK',
    );

    expect(handled).toBe(true);
    // Bound exactly once, conditionally on the ref being null (the idempotency lock).
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ providerChargeReference: null }),
        data: { providerChargeReference: 'PSTK_charge_ref' },
      }),
    );
    // Verified against Paystack's reference, not ours.
    expect(verifyTransaction).toHaveBeenCalledWith('PSTK_charge_ref');
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ event: { type: 'PAYMENT_VERIFIED', source: 'WEBHOOK' } }),
    );
  });

  it('is idempotent — a re-delivered charge whose ref is already bound never re-protects', async () => {
    const { service, verifyTransaction, apply } = makeDvaDeps({
      alreadyBound: {
        ...dvaPayment,
        providerChargeReference: 'PSTK_charge_ref',
        status: PaymentStatus.SUCCESS,
      },
    });

    await service.handleChargeSuccess(
      { reference: 'PSTK_charge_ref', customerCode: 'CUS_1' },
      'WEBHOOK',
    );

    expect(verifyTransaction).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('refuses to protect a DVA charge whose amount does not match', async () => {
    const { service, apply } = makeDvaDeps({ verifyAmount: 100000 });

    await expect(
      service.handleChargeSuccess(
        { reference: 'PSTK_charge_ref', customerCode: 'CUS_1' },
        'WEBHOOK',
      ),
    ).rejects.toBeInstanceOf(AmountMismatchError);
    expect(apply).not.toHaveBeenCalled();
  });

  it('returns false when nothing matches', async () => {
    const { service } = makeDvaDeps({ payment: null });
    const handled = await service.handleChargeSuccess(
      { reference: 'PSTK_charge_ref', customerCode: 'CUS_unknown' },
      'WEBHOOK',
    );
    expect(handled).toBe(false);
  });
});
