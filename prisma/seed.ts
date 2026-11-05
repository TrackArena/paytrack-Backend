import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import Decimal from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // ── Demo user ──────────────────────────────────────────────
  const passwordHash = await argon2.hash('Password123!', {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });

  const user = await prisma.user.upsert({
    where: { email: 'demo@paytrack.dev' },
    update: {},
    create: {
      email: 'demo@paytrack.dev',
      passwordHash,
      firstName: 'Alex',
      lastName: 'Demo',
      emailVerified: true,
    },
  });

  // ── Workspace ─────────────────────────────────────────────
  const workspace = await prisma.workspace.upsert({
    where: { slug: 'demo-workspace' },
    update: {},
    create: {
      name: 'Acme Corp',
      slug: 'demo-workspace',
      email: 'billing@acme.dev',
      currency: 'USD',
      country: 'US',
      city: 'San Francisco',
    },
  });

  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
    update: {},
    create: {
      workspaceId: workspace.id,
      userId: user.id,
      role: 'OWNER',
    },
  });

  // ── Stellar wallet (testnet) ──────────────────────────────
  // This is a publicly known testnet address — safe to include in seeds
  await prisma.stellarWallet.upsert({
    where: {
      workspaceId_publicKey_network: {
        workspaceId: workspace.id,
        publicKey: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        network: 'testnet',
      },
    },
    update: {},
    create: {
      workspaceId: workspace.id,
      publicKey: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      label: 'Main Receiving Wallet',
      network: 'testnet',
      isActive: true,
      isMonitored: true,
    },
  });

  // ── Customers ─────────────────────────────────────────────
  const customers = [
    {
      name: 'Bright Solutions Ltd',
      email: 'billing@brightsolutions.dev',
      company: 'Bright Solutions Ltd',
      country: 'US',
    },
    {
      name: 'Nova Digital Agency',
      email: 'finance@novadigital.dev',
      company: 'Nova Digital Agency',
      country: 'GB',
    },
    {
      name: 'Meridian Ventures',
      email: 'accounts@meridianvc.dev',
      company: 'Meridian Ventures',
      country: 'SG',
    },
    {
      name: 'Pulse Health Tech',
      email: 'ap@pulsehealth.dev',
      company: 'Pulse Health Tech',
      country: 'CA',
    },
  ];

  const createdCustomers = [];
  for (const c of customers) {
    const customer = await prisma.customer.upsert({
      where: {
        id: uuidv4(), // won't match, forces create path via catch
      },
      update: {},
      create: { workspaceId: workspace.id, ...c },
    }).catch(() =>
      prisma.customer.findFirst({ where: { workspaceId: workspace.id, email: c.email } })
    );
    if (customer) createdCustomers.push(customer);
  }

  // Simpler approach for seed
  const existingCustomers = await prisma.customer.findMany({
    where: { workspaceId: workspace.id },
  });
  const finalCustomers = existingCustomers.length > 0
    ? existingCustomers
    : await prisma.customer.createManyAndReturn({
        data: customers.map((c) => ({ workspaceId: workspace.id, ...c })),
      });

  // ── Invoices ──────────────────────────────────────────────
  const invoiceData = [
    {
      customer: finalCustomers[0],
      status: 'PAID' as const,
      items: [
        { description: 'Web Development — Sprint 1', quantity: 1, unitPrice: 2500 },
        { description: 'UI/UX Design', quantity: 1, unitPrice: 800 },
      ],
      daysAgo: 45,
    },
    {
      customer: finalCustomers[1],
      status: 'PENDING' as const,
      items: [
        { description: 'SEO Audit & Strategy', quantity: 1, unitPrice: 1200 },
        { description: 'Content Creation (10 articles)', quantity: 10, unitPrice: 150 },
      ],
      daysAgo: 10,
    },
    {
      customer: finalCustomers[2],
      status: 'OVERDUE' as const,
      items: [
        { description: 'Financial Consulting — Q3', quantity: 1, unitPrice: 5000 },
      ],
      daysAgo: 35,
    },
    {
      customer: finalCustomers[3],
      status: 'DRAFT' as const,
      items: [
        { description: 'Mobile App Development', quantity: 1, unitPrice: 8500 },
        { description: 'Backend API Integration', quantity: 1, unitPrice: 2000 },
        { description: 'QA & Testing', quantity: 1, unitPrice: 1000 },
      ],
      daysAgo: 2,
    },
    {
      customer: finalCustomers[0],
      status: 'PARTIALLY_PAID' as const,
      items: [
        { description: 'Annual Support Contract', quantity: 1, unitPrice: 4800 },
      ],
      daysAgo: 20,
    },
  ];

  for (let i = 0; i < invoiceData.length; i++) {
    const inv = invoiceData[i];
    const existingInv = await prisma.invoice.findFirst({
      where: { workspaceId: workspace.id, invoiceNumber: `INV-2024-${String(i + 1).padStart(4, '0')}` },
    });
    if (existingInv) continue;

    const subtotal = inv.items.reduce(
      (sum, item) => sum.plus(new Decimal(item.quantity).times(item.unitPrice)),
      new Decimal(0)
    );
    const totalAmount = subtotal;
    const paidAmount =
      inv.status === 'PAID' ? totalAmount :
      inv.status === 'PARTIALLY_PAID' ? totalAmount.dividedBy(2).toDecimalPlaces(2) :
      new Decimal(0);

    const createdAt = new Date(Date.now() - inv.daysAgo * 24 * 60 * 60 * 1000);
    const invoiceNumber = `INV-2024-${String(i + 1).padStart(4, '0')}`;

    await prisma.invoice.create({
      data: {
        workspaceId: workspace.id,
        customerId: inv.customer?.id,
        invoiceNumber,
        status: inv.status,
        currency: 'USDC',
        subtotal,
        taxAmount: new Decimal(0),
        discountAmount: new Decimal(0),
        totalAmount,
        paidAmount,
        memo: invoiceNumber.replace(/-/g, ''),
        dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        issuedAt: inv.status !== 'DRAFT' ? createdAt : null,
        paidAt: inv.status === 'PAID' ? new Date(createdAt.getTime() + 3 * 24 * 60 * 60 * 1000) : null,
        items: {
          create: inv.items.map((item) => ({
            description: item.description,
            quantity: new Decimal(item.quantity),
            unitPrice: new Decimal(item.unitPrice),
            amount: new Decimal(item.quantity).times(item.unitPrice),
          })),
        },
      },
    });
  }

  // ── Sample completed payment ──────────────────────────────
  const paidInvoice = await prisma.invoice.findFirst({
    where: { workspaceId: workspace.id, status: 'PAID' },
  });

  if (paidInvoice) {
    const existingPayment = await prisma.payment.findFirst({
      where: { workspaceId: workspace.id, invoiceId: paidInvoice.id },
    });

    if (!existingPayment) {
      const seedTxHash = 'seed_tx_' + uuidv4().replace(/-/g, '');
      const payment = await prisma.payment.create({
        data: {
          workspaceId: workspace.id,
          invoiceId: paidInvoice.id,
          customerId: paidInvoice.customerId,
          status: 'COMPLETED',
          amount: paidInvoice.totalAmount,
          currency: 'USDC',
          stellarTransactionHash: seedTxHash,
          idempotencyKey: `seed:${seedTxHash}`,
          receivedAt: paidInvoice.paidAt || new Date(),
          verifiedAt: paidInvoice.paidAt || new Date(),
          blockchainTransaction: {
            create: {
              transactionHash: seedTxHash,
              network: 'testnet',
              sourceAccount: 'GSEEDER000000000000000000000000000000000000000000000000001',
              destinationAccount: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              assetCode: 'USDC',
              assetIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              amount: paidInvoice.totalAmount,
              memo: paidInvoice.memo,
              status: 'VERIFIED',
              verifiedAt: new Date(),
              stellarCreatedAt: paidInvoice.paidAt || new Date(),
            },
          },
          reconciliation: {
            create: {
              invoiceId: paidInvoice.id,
              status: 'MATCHED',
              paymentAmount: paidInvoice.totalAmount,
              invoiceAmount: paidInvoice.totalAmount,
              difference: new Decimal(0),
              matchConfidence: new Decimal(100),
              notes: 'Seed data — demonstration record',
            },
          },
        },
      });

      console.log('Created seed payment:', payment.id);
    }
  }

  console.log('✅ Seed complete');
  console.log('   Demo login: demo@paytrack.dev / Password123!');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
