import { ForbiddenException } from '@nestjs/common';
import type { SupabaseJwtClaims } from '@/modules/auth';
import { InvoicesController } from './invoices.controller';
import type { InvoicesService } from './invoices.service';
import type { CreateInvoiceDto } from './dto/create-invoice.dto';
import type { UpdateInvoiceDto } from './dto/update-invoice.dto';

function claims(sub: string, appRole = 'SELLER'): SupabaseJwtClaims {
  return { sub, email: `${sub}@x.com`, role: 'authenticated', appRole, raw: { sub } };
}

function makeCtl(
  invoice: Record<string, unknown> = { id: 'inv-1', sellerId: 'seller-1', status: 'DRAFT' },
) {
  const invoices = {
    createDraft: jest.fn().mockResolvedValue({ id: 'inv-1', status: 'DRAFT' }),
    edit: jest.fn().mockResolvedValue({ id: 'inv-1', status: 'DRAFT' }),
    send: jest.fn().mockResolvedValue({ id: 'inv-1', status: 'SENT' }),
    void: jest.fn().mockResolvedValue({ id: 'inv-1', status: 'VOID' }),
    remind: jest.fn().mockResolvedValue(undefined),
    listForSeller: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getById: jest.fn().mockResolvedValue(invoice),
  };
  const controller = new InvoicesController(invoices as unknown as InvoicesService);
  return { controller, invoices };
}

describe('InvoicesController.create', () => {
  it('creates a draft owned by the calling seller', async () => {
    const { controller, invoices } = makeCtl();
    const dto = { lineItems: [] } as unknown as CreateInvoiceDto;

    await controller.create(claims('seller-1'), dto);

    expect(invoices.createDraft).toHaveBeenCalledWith('seller-1', dto);
  });
});

describe('InvoicesController.list', () => {
  it('lists the calling seller with the passed filters', async () => {
    const { controller, invoices } = makeCtl();

    await controller.list(claims('seller-1'), { cursor: 'c1', limit: 10 });

    expect(invoices.listForSeller).toHaveBeenCalledWith('seller-1', { cursor: 'c1', limit: 10 });
  });
});

describe('InvoicesController.edit', () => {
  it('delegates to edit with seller id, path id, and body', async () => {
    const { controller, invoices } = makeCtl();
    const dto = { notes: 'x' } as UpdateInvoiceDto;

    await controller.edit(claims('seller-1'), 'inv-1', dto);

    expect(invoices.edit).toHaveBeenCalledWith('seller-1', 'inv-1', dto);
  });
});

describe('InvoicesController.send', () => {
  it('delegates to send with seller id + path id', async () => {
    const { controller, invoices } = makeCtl();

    await controller.send(claims('seller-1'), 'inv-1');

    expect(invoices.send).toHaveBeenCalledWith('seller-1', 'inv-1');
  });
});

describe('InvoicesController.void', () => {
  it('delegates to void with seller id + path id', async () => {
    const { controller, invoices } = makeCtl();

    await controller.void(claims('seller-1'), 'inv-1');

    expect(invoices.void).toHaveBeenCalledWith('seller-1', 'inv-1');
  });
});

describe('InvoicesController.remind', () => {
  it('delegates to remind with seller id + path id', async () => {
    const { controller, invoices } = makeCtl();

    await controller.remind(claims('seller-1'), 'inv-1');

    expect(invoices.remind).toHaveBeenCalledWith('seller-1', 'inv-1');
  });
});

describe('InvoicesController.get', () => {
  it('returns the invoice for its owner', async () => {
    const { controller } = makeCtl();

    await expect(controller.get(claims('seller-1'), 'inv-1')).resolves.toEqual(
      expect.objectContaining({ id: 'inv-1' }),
    );
  });

  it('forbids a caller who is not the owning seller', async () => {
    const { controller, invoices } = makeCtl();

    await expect(controller.get(claims('intruder'), 'inv-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(invoices.getById).toHaveBeenCalledWith('inv-1');
  });
});
