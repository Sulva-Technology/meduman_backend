import { ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '@/prisma/prisma.service';
import type { PaystackService } from '@/common/paystack/paystack.service';
import type { AuditService } from '@/modules/audit/audit.service';
import type { Env } from '@/config/env.validation';
import { SellerProfileService } from './seller-profile.service';

function makeService(profile: Record<string, unknown> | null) {
  const prisma = {
    sellerProfile: {
      findUnique: jest.fn().mockResolvedValue(profile),
      create: jest.fn().mockResolvedValue({ userId: 'u1', id: 'sp1' }),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'sp1', ...data })),
    },
    transaction: { count: jest.fn().mockResolvedValue(0) },
  };
  const paystack = {
    createSubaccount: jest.fn().mockResolvedValue({ subaccountCode: 'ACCT_new' }),
    resolveAccount: jest.fn().mockResolvedValue({ accountName: 'ADA OKAFOR' }),
    createTransferRecipient: jest.fn().mockResolvedValue({ recipientCode: 'RCP_new' }),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn().mockReturnValue(2) } as unknown as ConfigService<Env, true>;
  const service = new SellerProfileService(
    prisma as unknown as PrismaService,
    paystack as unknown as PaystackService,
    audit as unknown as AuditService,
    config,
  );
  return { service, prisma, paystack, audit };
}

const bank = { businessName: 'Ada Store', settlementBank: '058', accountNumber: '0123456789' };

describe('SellerProfileService.createSubaccount', () => {
  it('creates the Paystack subaccount, stores the code, and audits it (rule 6)', async () => {
    const { service, prisma, paystack, audit } = makeService({
      id: 'sp1',
      userId: 'u1',
      businessName: 'Ada Store',
      paystackSubaccountCode: null,
    });

    const result = await service.createSubaccount('u1', bank);

    expect(paystack.createSubaccount).toHaveBeenCalledWith(
      expect.objectContaining({ settlementBank: '058', accountNumber: '0123456789' }),
    );
    expect(prisma.sellerProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paystackSubaccountCode: 'ACCT_new',
          settlementBankVerified: true,
        }),
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'seller.subaccount_created' }),
    );
    expect(result.paystackSubaccountCode).toBe('ACCT_new');
  });

  it('refuses a second subaccount — no duplicate settlement destination', async () => {
    const { service, paystack } = makeService({
      id: 'sp1',
      userId: 'u1',
      businessName: 'Ada Store',
      paystackSubaccountCode: 'ACCT_existing',
    });

    await expect(service.createSubaccount('u1', bank)).rejects.toBeInstanceOf(ConflictException);
    expect(paystack.createSubaccount).not.toHaveBeenCalled();
  });
});

const recipient = { bankCode: '058', accountNumber: '0123456789' };

describe('SellerProfileService.createTransferRecipient', () => {
  it('resolves the account with the bank before creating the recipient', async () => {
    const { service, paystack } = makeService({
      id: 'sp1',
      userId: 'u1',
      businessName: 'Ada Store',
      providerRecipientCode: null,
    });

    await service.createTransferRecipient('u1', recipient);

    expect(paystack.resolveAccount).toHaveBeenCalledWith({
      accountNumber: '0123456789',
      bankCode: '058',
    });
    expect(paystack.createTransferRecipient).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'ADA OKAFOR',
        accountNumber: '0123456789',
        bankCode: '058',
      }),
    );
  });

  it('stores the recipient code and masked settlement details, never the full account number', async () => {
    const { service, prisma } = makeService({
      id: 'sp1',
      userId: 'u1',
      businessName: 'Ada Store',
      providerRecipientCode: null,
    });

    await service.createTransferRecipient('u1', recipient);

    const written = prisma.sellerProfile.update.mock.calls[0][0].data;
    expect(written).toMatchObject({
      providerRecipientCode: 'RCP_new',
      settlementBankCode: '058',
      settlementAccountLast4: '6789',
      settlementAccountName: 'ADA OKAFOR',
      settlementBankVerified: true,
    });
    expect(JSON.stringify(written)).not.toContain('0123456789');
  });

  it('audits the onboarding without leaking the full account number (rule 6)', async () => {
    const { service, audit } = makeService({
      id: 'sp1',
      userId: 'u1',
      providerRecipientCode: null,
    });

    await service.createTransferRecipient('u1', recipient);

    const entry = audit.log.mock.calls[0][0];
    expect(entry).toMatchObject({ action: 'seller.transfer_recipient_created' });
    expect(JSON.stringify(entry)).not.toContain('0123456789');
  });

  it('refuses a second recipient — one payout destination per seller', async () => {
    const { service, paystack } = makeService({
      id: 'sp1',
      userId: 'u1',
      providerRecipientCode: 'RCP_existing',
    });

    await expect(service.createTransferRecipient('u1', recipient)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(paystack.resolveAccount).not.toHaveBeenCalled();
    expect(paystack.createTransferRecipient).not.toHaveBeenCalled();
  });
});

describe('SellerProfileService.toSelfView', () => {
  it('is settlement-ready only once a transfer recipient exists', () => {
    const { service } = makeService(null);
    const base = {
      businessName: 'Ada Store',
      category: null,
      verificationStatus: 'VERIFIED',
      trustLevel: 'NEW',
      badgeSlug: null,
      settlementBankVerified: true,
      settlementAccountLast4: '6789',
      settlementAccountName: 'ADA OKAFOR',
    };

    const withoutRecipient = service.toSelfView({
      ...base,
      providerRecipientCode: null,
    } as never);
    const withRecipient = service.toSelfView({
      ...base,
      providerRecipientCode: 'RCP_1',
    } as never);

    expect(withoutRecipient.settlementReady).toBe(false);
    expect(withRecipient.settlementReady).toBe(true);
  });
});
