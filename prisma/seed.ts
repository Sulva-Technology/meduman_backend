/**
 * Meduman seed — exercises the admin dashboards immediately.
 *
 * Creates:
 *   - 2 app users: one buyer, one seller (seller has a SellerProfile with a
 *     Paystack subaccount + verified settlement bank).
 *   - 1 AdminUser for EACH AdminRole (6 total).
 *   - 1 Transaction in EACH of the 12 TransactionStatus lifecycle states, with
 *     the related rows (payment/payout/dispute/otp/timeline/audit) that a real
 *     transaction in that state would carry.
 *   - Supporting rows: waitlist entries, notifications, a webhook event.
 *
 * All money is in MINOR UNITS (kobo). Re-runnable: wipes transaction data and
 * upserts identity rows.
 *
 * Run: `npm run prisma:seed` (or `npx prisma db seed`).
 */
import {
  PrismaClient,
  AdminRole,
  TransactionStatus,
  ReleaseRule,
  FeeModel,
  PaymentStatus,
  PayoutStatus,
  DisputeReason,
  DisputeStatus,
  DisputeOutcome,
  OtpPurpose,
  ScanStatus,
  ActorType,
  NotificationChannel,
  NotificationStatus,
} from '@prisma/client';

/**
 * Refuse to run anywhere that could be production. This script calls
 * `deleteMany()` on transactions, audit logs and waitlist entries — running it
 * against a live database destroys the money trail rule 6 exists to protect.
 *
 * `prisma migrate deploy` (what render.yaml runs) never triggers seeding, so
 * the deploy path is already safe. This guards the other one: a human with
 * production credentials exported in their shell.
 */
function assertSafeToSeed(): void {
  const url = process.env.DATABASE_URL ?? '';
  const override = process.env.I_UNDERSTAND_THIS_WIPES_DATA === '1';

  if (override) {
    console.warn('⚠️  Seed running with I_UNDERSTAND_THIS_WIPES_DATA=1 — destructive.');
    return;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV=production. This script deletes transaction data.');
  }
  if (!url) {
    throw new Error('Refusing to seed: DATABASE_URL is not set.');
  }
  // Only local hosts are seedable without an explicit override.
  const isLocal = /@(localhost|127\.0\.0\.1|host\.docker\.internal|postgres)[:/]/.test(url);
  if (!isLocal) {
    throw new Error(
      'Refusing to seed: DATABASE_URL does not point at a local database. ' +
        'This script deletes transactions, audit logs and waitlist entries. ' +
        'Set I_UNDERSTAND_THIS_WIPES_DATA=1 only if you are certain.',
    );
  }
}

const prisma = new PrismaClient();

// Fixed UUIDs so re-seeding + local testing is deterministic.
const BUYER_ID = '11111111-1111-1111-1111-111111111111';
const SELLER_ID = '22222222-2222-2222-2222-222222222222';

const NGN = (naira: number): number => naira * 100; // -> kobo (minor units)

async function resetTransactionalData(): Promise<void> {
  // Order matters only where cascades don't cover it; Transaction cascades to
  // items/payments/payouts/disputes/evidence/timeline/otp.
  await prisma.transaction.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.waitlistEntry.deleteMany();
}

async function seedUsers(): Promise<void> {
  await prisma.user.upsert({
    where: { id: BUYER_ID },
    update: {},
    create: {
      id: BUYER_ID,
      email: 'buyer@meduman.test',
      phone: '+2348030000001',
      fullName: 'Bimpe Buyer',
      roleFlags: ['BUYER'],
      status: 'ACTIVE',
      profile: {
        create: {
          country: 'Nigeria',
          city: 'Lagos',
          bio: 'Test buyer account.',
          channelLinks: { instagram: '@bimpe_buys' },
        },
      },
    },
  });

  await prisma.user.upsert({
    where: { id: SELLER_ID },
    update: {},
    create: {
      id: SELLER_ID,
      email: 'seller@meduman.test',
      phone: '+2348030000002',
      fullName: 'Sesan Seller',
      roleFlags: ['SELLER', 'BUSINESS'],
      status: 'ACTIVE',
      profile: {
        create: {
          country: 'Nigeria',
          city: 'Abuja',
          bio: 'Test seller account.',
          channelLinks: { whatsapp: '+2348030000002', tiktok: '@sesan_store' },
        },
      },
      sellerProfile: {
        create: {
          businessName: 'Sesan Store',
          category: 'Fashion & Apparel',
          verificationStatus: 'VERIFIED',
          trustLevel: 'TRUSTED',
          badgeSlug: 'sesan-store',
          paystackSubaccountCode: 'ACCT_test_sesan_0001',
          settlementBankVerified: true,
        },
      },
    },
  });
}

async function seedAdmins(): Promise<void> {
  const roles: AdminRole[] = [
    AdminRole.SUPER_ADMIN,
    AdminRole.OPERATIONS,
    AdminRole.DISPUTE_REVIEWER,
    AdminRole.COMPLIANCE,
    AdminRole.FINANCE,
    AdminRole.SUPPORT,
  ];

  for (const role of roles) {
    const email = `${role.toLowerCase()}@meduman.test`;
    await prisma.adminUser.upsert({
      where: { email },
      update: { role },
      create: {
        email,
        fullName: `${role} Admin`,
        role,
        status: 'ACTIVE',
      },
    });
  }
}

/** Which lifecycle states have a known buyer (link has been paid or claimed). */
const STATES_WITH_BUYER = new Set<TransactionStatus>([
  TransactionStatus.PAYMENT_PENDING,
  TransactionStatus.PAYMENT_PROTECTED,
  TransactionStatus.DELIVERY_IN_PROGRESS,
  TransactionStatus.CONFIRMATION_PENDING,
  TransactionStatus.DISPUTED,
  TransactionStatus.RELEASE_PROCESSING,
  TransactionStatus.COMPLETED,
  TransactionStatus.REFUNDED,
]);

/** States where funds are (or were) collected into the protected state. */
const STATES_WITH_SUCCESSFUL_PAYMENT = new Set<TransactionStatus>([
  TransactionStatus.PAYMENT_PROTECTED,
  TransactionStatus.DELIVERY_IN_PROGRESS,
  TransactionStatus.CONFIRMATION_PENDING,
  TransactionStatus.DISPUTED,
  TransactionStatus.RELEASE_PROCESSING,
  TransactionStatus.COMPLETED,
  TransactionStatus.REFUNDED,
]);

async function seedTransactions(): Promise<void> {
  const allStates = Object.values(TransactionStatus);
  let n = 0;

  for (const status of allStates) {
    n += 1;
    const amount = NGN(1000 + n * 250); // varied amounts, kobo
    const feeAmount = Math.round(amount * 0.015); // 1.5% platform fee, kobo
    const hasBuyer = STATES_WITH_BUYER.has(status);
    const paidOk = STATES_WITH_SUCCESSFUL_PAYMENT.has(status);
    const slug = status.toLowerCase().replace(/_/g, '-');

    const tx = await prisma.transaction.create({
      data: {
        publicLinkId: `seed-${slug}-${n.toString().padStart(2, '0')}`,
        sellerId: SELLER_ID,
        buyerId: hasBuyer ? BUYER_ID : null,
        title: `Sample: ${status}`,
        description: `Seed transaction demonstrating the ${status} state.`,
        amount,
        currency: 'NGN',
        status,
        releaseRule: ReleaseRule.BUYER_CONFIRMATION,
        expectedDeliveryDate: new Date(Date.now() + 3 * 864e5),
        expiresAt:
          status === TransactionStatus.EXPIRED
            ? new Date(Date.now() - 864e5)
            : new Date(Date.now() + 7 * 864e5),
        feeModel: FeeModel.BUYER_PAYS,
        feeAmount,
        items: {
          create: [
            {
              title: 'Item A',
              description: 'First line item.',
              quantity: 1,
              deliveryMethod: 'Courier',
              deliveryTerms: 'Delivery within 3 business days.',
            },
          ],
        },
      },
    });

    // Payment row for any state that reached payment.
    if (status === TransactionStatus.PAYMENT_PENDING) {
      await prisma.payment.create({
        data: {
          transactionId: tx.id,
          provider: 'paystack',
          providerReference: `PS_ref_${slug}_${n}`,
          amount: amount + feeAmount,
          status: PaymentStatus.PENDING,
        },
      });
    } else if (paidOk) {
      await prisma.payment.create({
        data: {
          transactionId: tx.id,
          provider: 'paystack',
          providerReference: `PS_ref_${slug}_${n}`,
          amount: amount + feeAmount,
          status: PaymentStatus.SUCCESS,
          verifiedAt: new Date(),
          rawPayload: { event: 'charge.success', seeded: true },
        },
      });
    }

    // Payout row where a release is in flight or done.
    if (status === TransactionStatus.RELEASE_PROCESSING) {
      await prisma.payout.create({
        data: {
          transactionId: tx.id,
          sellerId: SELLER_ID,
          idempotencyKey: `payout_${tx.id}`,
          amount: amount - feeAmount,
          status: PayoutStatus.PROCESSING,
          attemptCount: 1,
        },
      });
    } else if (status === TransactionStatus.COMPLETED) {
      await prisma.payout.create({
        data: {
          transactionId: tx.id,
          sellerId: SELLER_ID,
          idempotencyKey: `payout_${tx.id}`,
          providerTransferCode: `TRF_${slug}_${n}`,
          amount: amount - feeAmount,
          status: PayoutStatus.SUCCESS,
          attemptCount: 1,
        },
      });
    }

    // OTP awaiting confirmation.
    if (status === TransactionStatus.CONFIRMATION_PENDING) {
      await prisma.otpCode.create({
        data: {
          transactionId: tx.id,
          codeHash: 'seed$hash$never-plaintext',
          purpose: OtpPurpose.DELIVERY_CONFIRMATION,
          expiresAt: new Date(Date.now() + 6e5),
        },
      });
    }

    // Open dispute + a piece of evidence.
    if (status === TransactionStatus.DISPUTED) {
      const dispute = await prisma.dispute.create({
        data: {
          transactionId: tx.id,
          openedBy: BUYER_ID,
          reason: DisputeReason.NOT_AS_DESCRIBED,
          description: 'Item colour differs from the listing.',
          desiredOutcome: DisputeOutcome.REFUND,
          status: DisputeStatus.OPEN,
          responseDeadline: new Date(Date.now() + 2 * 864e5),
        },
      });
      await prisma.evidence.create({
        data: {
          transactionId: tx.id,
          disputeId: dispute.id,
          uploadedBy: BUYER_ID,
          storagePath: `evidence/${tx.id}/photo-1.jpg`,
          mimeType: 'image/jpeg',
          sizeBytes: 245_760,
          scanStatus: ScanStatus.CLEAN,
        },
      });
    }

    // User-facing timeline + immutable audit row for every transaction.
    await prisma.timelineEvent.create({
      data: {
        transactionId: tx.id,
        actorId: SELLER_ID,
        actorRole: 'SELLER',
        type: 'transaction.seeded',
        newState: status,
        metadata: { seeded: true },
      },
    });
    await prisma.auditLog.create({
      data: {
        actorType: ActorType.SYSTEM,
        action: 'transaction.status_change',
        targetType: 'Transaction',
        targetId: tx.id,
        reason: 'Seed script',
        metadata: { seeded: true, newState: status },
      },
    });
  }
}

async function seedMisc(): Promise<void> {
  await prisma.notification.create({
    data: {
      userId: BUYER_ID,
      channel: NotificationChannel.EMAIL,
      templateKey: 'payment.protected',
      payload: { title: 'Your payment is protected' },
      status: NotificationStatus.SENT,
      sentAt: new Date(),
    },
  });

  await prisma.waitlistEntry.createMany({
    data: [
      {
        fullName: 'Wale Waitlist',
        email: 'wale@waitlist.test',
        phone: '+2348030000010',
        userType: 'seller',
        channel: 'Instagram',
        country: 'Nigeria',
        city: 'Ibadan',
        useCase: 'Selling sneakers on IG.',
        avgTransactionValue: NGN(45000),
        consent: true,
      },
      {
        fullName: 'Bola Waitlist',
        email: 'bola@waitlist.test',
        userType: 'buyer',
        channel: 'WhatsApp',
        consent: true,
      },
    ],
  });

  await prisma.webhookEvent.create({
    data: {
      provider: 'paystack',
      providerEventId: 'evt_seed_0001',
      eventType: 'charge.success',
      rawPayload: { event: 'charge.success', seeded: true },
      processedAt: new Date(),
      processingResult: 'ok',
    },
  });
}

async function main(): Promise<void> {
  assertSafeToSeed();
  await resetTransactionalData();
  await seedUsers();
  await seedAdmins();
  await seedTransactions();
  await seedMisc();

  const txCount = await prisma.transaction.count();
  // eslint-disable-next-line no-console
  console.log(`Seed complete: ${txCount} transactions (one per lifecycle state).`);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
