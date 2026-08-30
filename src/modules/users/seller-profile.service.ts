import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ActorType, type SellerProfile } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';
import { PaystackService, type BankOption } from '@/common/paystack/paystack.service';
import { AuditService } from '@/modules/audit/audit.service';
import type { Env } from '@/config/env.validation';
import type { UpdateSellerProfileDto } from './dto/update-seller-profile.dto';
import type { CreateSubaccountDto } from './dto/create-subaccount.dto';
import type { CreateTransferRecipientDto } from './dto/create-transfer-recipient.dto';

/** The seller's own profile view. Never exposes the raw Paystack subaccount code. */
export interface SellerProfileSelfView {
  businessName: string | null;
  category: string | null;
  verificationStatus: SellerProfile['verificationStatus'];
  trustLevel: SellerProfile['trustLevel'];
  badgeSlug: string | null;
  settlementBankVerified: boolean;
  /** Masked settlement account — last 4 digits only. */
  settlementAccountLast4: string | null;
  /** Bank-resolved account name, so the seller can confirm where money lands. */
  settlementAccountName: string | null;
  /** True once the seller can actually receive a payout (recipient onboarded). */
  settlementReady: boolean;
}

/** Public trust-badge view — no ids, no settlement fields. */
export interface SellerPublicView {
  businessName: string | null;
  verificationStatus: SellerProfile['verificationStatus'];
  trustLevel: SellerProfile['trustLevel'];
  completedTransactions: number;
  memberSince: Date;
}

@Injectable()
export class SellerProfileService {
  private readonly percentageCharge: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackService,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.percentageCharge = config.get('PAYSTACK_SUBACCOUNT_PERCENTAGE_CHARGE', { infer: true });
  }

  /** Bank options for the seller's settlement-account picker. */
  async listBanks(): Promise<BankOption[]> {
    return this.paystack.listBanks();
  }

  /** Load the caller's seller profile, creating an empty one on first read. */
  async getOrCreate(userId: string): Promise<SellerProfile> {
    const existing = await this.prisma.sellerProfile.findUnique({ where: { userId } });
    if (existing) return existing;
    return this.prisma.sellerProfile.create({ data: { userId } });
  }

  toSelfView(profile: SellerProfile): SellerProfileSelfView {
    return {
      businessName: profile.businessName,
      category: profile.category,
      verificationStatus: profile.verificationStatus,
      trustLevel: profile.trustLevel,
      badgeSlug: profile.badgeSlug,
      settlementBankVerified: profile.settlementBankVerified,
      settlementAccountLast4: profile.settlementAccountLast4,
      settlementAccountName: profile.settlementAccountName,
      // Ready means "a transfer can actually be sent" — i.e. a recipient exists.
      settlementReady: !!profile.providerRecipientCode,
    };
  }

  /** Update only client-writable fields (server-owned fields are untouched). */
  async update(userId: string, dto: UpdateSellerProfileDto): Promise<SellerProfile> {
    await this.getOrCreate(userId);
    return this.prisma.sellerProfile.update({
      where: { userId },
      data: {
        ...(dto.businessName !== undefined ? { businessName: dto.businessName } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
      },
    });
  }

  /**
   * Create the seller's Paystack subaccount and persist the returned code.
   * Idempotent: if a subaccount already exists, we refuse rather than create a
   * second one (a second settlement destination would be a money-safety hazard).
   * Writes an audit row (rule 6).
   */
  async createSubaccount(userId: string, dto: CreateSubaccountDto): Promise<SellerProfile> {
    const profile = await this.getOrCreate(userId);
    if (profile.paystackSubaccountCode) {
      throw new ConflictException('A settlement subaccount already exists for this seller');
    }

    const { subaccountCode } = await this.paystack.createSubaccount({
      businessName: dto.businessName,
      settlementBank: dto.settlementBank,
      accountNumber: dto.accountNumber,
      percentageCharge: this.percentageCharge,
    });

    const updated = await this.prisma.sellerProfile.update({
      where: { userId },
      data: {
        paystackSubaccountCode: subaccountCode,
        settlementBankVerified: true,
        ...(profile.businessName ? {} : { businessName: dto.businessName }),
      },
    });

    await this.audit.log({
      action: 'seller.subaccount_created',
      targetType: 'SellerProfile',
      targetId: updated.id,
      actorId: userId,
      actorType: ActorType.USER,
      metadata: { settlementBank: dto.settlementBank },
    });

    return updated;
  }

  /**
   * Onboard the seller's payout destination (decision D-0). The account is
   * resolved with the bank first, so the recipient name comes from the bank and
   * a mistyped account fails before any money can move. Only the recipient code
   * and masked details are persisted — never the full account number.
   *
   * One destination per seller: a second one is refused rather than silently
   * repointing where released funds land. Changing banks is an admin action.
   */
  async createTransferRecipient(
    userId: string,
    dto: CreateTransferRecipientDto,
  ): Promise<SellerProfile> {
    const profile = await this.getOrCreate(userId);
    if (profile.providerRecipientCode) {
      throw new ConflictException('A payout destination already exists for this seller');
    }

    const resolved = await this.paystack.resolveAccount({
      accountNumber: dto.accountNumber,
      bankCode: dto.bankCode,
    });
    const { recipientCode } = await this.paystack.createTransferRecipient({
      name: resolved.accountName,
      accountNumber: dto.accountNumber,
      bankCode: dto.bankCode,
    });

    const updated = await this.prisma.sellerProfile.update({
      where: { userId },
      data: {
        providerRecipientCode: recipientCode,
        settlementBankCode: dto.bankCode,
        settlementAccountLast4: dto.accountNumber.slice(-4),
        settlementAccountName: resolved.accountName,
        settlementBankVerified: true,
      },
    });

    await this.audit.log({
      action: 'seller.transfer_recipient_created',
      targetType: 'SellerProfile',
      targetId: updated.id,
      actorId: userId,
      actorType: ActorType.USER,
      // Masked on purpose — an audit row must never carry a full account number.
      metadata: {
        bankCode: dto.bankCode,
        accountLast4: dto.accountNumber.slice(-4),
        accountName: resolved.accountName,
      },
    });

    return updated;
  }

  /** Public trust badge by slug. 404 for unknown/unverified slugs. */
  async getPublicByBadgeSlug(badgeSlug: string): Promise<SellerPublicView> {
    const profile = await this.prisma.sellerProfile.findUnique({ where: { badgeSlug } });
    if (!profile) {
      throw new NotFoundException('Seller badge not found');
    }
    const completedTransactions = await this.prisma.transaction.count({
      where: { sellerId: profile.userId, status: 'COMPLETED' },
    });
    return {
      businessName: profile.businessName,
      verificationStatus: profile.verificationStatus,
      trustLevel: profile.trustLevel,
      completedTransactions,
      memberSince: profile.createdAt,
    };
  }
}
