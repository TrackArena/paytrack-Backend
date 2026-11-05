import { Horizon } from '@stellar/stellar-sdk';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { StellarService } from './stellar.service';
import { ReconciliationEngine } from '../payment/reconciliation.engine';

type PaymentOp = Horizon.HorizonApi.PaymentOperationResponse & {
  to?: string;
  asset_code?: string;
  asset_issuer?: string;
  amount?: string;
  transaction_hash: string;
};

const POLL_INTERVAL_MS = parseInt(
  process.env.STELLAR_POLL_INTERVAL_MS || '30000',
  10
);
const MAX_RETRIES = parseInt(process.env.STELLAR_MAX_RETRIES || '3', 10);

/**
 * TransactionMonitor — backend worker that polls monitored Stellar wallets
 * for incoming payments and triggers the reconciliation engine.
 *
 * Runs on the server, not in the browser.
 * Survives service restarts by persisting the Horizon cursor per wallet.
 */
export class TransactionMonitor {
  private stellar = new StellarService();
  private reconciliation = new ReconciliationEngine();
  private isRunning = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;

  async start(): Promise<void> {
    this.isRunning = true;
    logger.info('Transaction monitor started', {
      pollInterval: POLL_INTERVAL_MS,
      network: process.env.STELLAR_NETWORK || 'testnet',
    });
    await this.poll();
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('Transaction monitor stopped');
  }

  private scheduleNext(): void {
    if (!this.isRunning) return;
    this.timer = setTimeout(() => {
      this.poll().catch((err) => {
        logger.error('Transaction monitor poll error', { error: err });
      });
    }, POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    try {
      const network = (process.env.STELLAR_NETWORK as 'testnet' | 'mainnet') || 'testnet';

      // Fetch all active monitored wallets for this network
      const wallets = await prisma.stellarWallet.findMany({
        where: { isActive: true, isMonitored: true, network },
      });

      if (wallets.length === 0) {
        this.scheduleNext();
        return;
      }

      logger.debug('Polling wallets', { count: wallets.length, network });

      for (const wallet of wallets) {
        await this.processWallet(wallet, network);
      }

      this.retryCount = 0;
    } catch (error) {
      this.retryCount++;
      logger.error('Transaction monitor poll failed', {
        error: error instanceof Error ? error.message : String(error),
        retryCount: this.retryCount,
      });

      if (this.retryCount >= MAX_RETRIES) {
        logger.error('Transaction monitor exceeded max retries, pausing for 5 minutes');
        this.timer = setTimeout(() => {
          this.retryCount = 0;
          this.poll();
        }, 5 * 60 * 1000);
        return;
      }
    }

    this.scheduleNext();
  }

  private async processWallet(
    wallet: { id: string; publicKey: string; workspaceId: string; lastCursor: string | null },
    network: 'testnet' | 'mainnet'
  ): Promise<void> {
    try {
      const { payments, nextCursor } = await this.stellar.pollPayments(
        wallet.publicKey,
        network,
        wallet.lastCursor || undefined
      );

      if (payments.length === 0) {
        return;
      }

      logger.info('New payments detected', {
        walletId: wallet.id,
        publicKey: wallet.publicKey,
        count: payments.length,
      });

      for (const payment of payments) {
        await this.processPayment(payment, wallet, network);
      }

      // Save cursor so we resume from here after a restart
      await prisma.stellarWallet.update({
        where: { id: wallet.id },
        data: { lastCursor: nextCursor },
      });
    } catch (error) {
      logger.error('Failed to process wallet', {
        walletId: wallet.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async processPayment(
    payment: PaymentOp,
    wallet: { id: string; publicKey: string; workspaceId: string },
    network: 'testnet' | 'mainnet'
  ): Promise<void> {
    const txHash = payment.transaction_hash;

    // Idempotency check — never process the same transaction twice
    const existing = await prisma.payment.findUnique({
      where: { stellarTransactionHash: txHash },
    });
    if (existing) {
      logger.debug('Transaction already processed, skipping', { txHash });
      return;
    }

    // Only process incoming payments to this wallet
    const destination = payment.to;
    if (destination !== wallet.publicKey) return;

    // Verify asset is USDC with correct issuer
    const assetCode = payment.asset_type === 'native' ? 'XLM' : (payment.asset_code || '');
    const assetIssuer = payment.asset_type === 'native' ? '' : (payment.asset_issuer || '');

    if (!this.stellar.isUSDC(assetCode, assetIssuer, network)) {
      logger.info('Non-USDC payment detected, skipping auto-reconciliation', {
        txHash,
        assetCode,
        assetIssuer,
      });
      return;
    }

    // Independently verify the full transaction via Horizon
    const txDetails = await this.stellar.verifyTransaction(txHash, network);
    if (!txDetails || !txDetails.successful) {
      logger.warn('Transaction failed verification', { txHash });
      return;
    }

    try {
      await this.reconciliation.reconcile({
        transactionHash: txHash,
        workspaceId: wallet.workspaceId,
        txDetails,
        submittedByUserId: null, // system-initiated
      });

      logger.info('Auto-reconciliation complete', {
        txHash,
        workspaceId: wallet.workspaceId,
        amount: txDetails.amount,
      });
    } catch (error) {
      logger.error('Auto-reconciliation failed', {
        txHash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
