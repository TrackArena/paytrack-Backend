import { Horizon } from '@stellar/stellar-sdk';
import { logger } from '../../lib/logger';
import { StellarError } from '../../lib/errors';

// ============================================================
// USDC Issuer Addresses
// Authoritative addresses from Circle's official documentation.
// https://developers.circle.com/docs/usdc-on-stellar
// ============================================================
export const USDC_ISSUERS = {
  testnet: process.env.STELLAR_USDC_ISSUER_TESTNET ||
    'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  mainnet: process.env.STELLAR_USDC_ISSUER_MAINNET ||
    'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
};

export interface VerifiedTransaction {
  hash: string;
  network: 'testnet' | 'mainnet';
  ledger: number;
  sourceAccount: string;
  destinationAccount: string;
  assetCode: string;
  assetIssuer: string;
  amount: string;
  memo: string | null;
  createdAt: string;
  successful: boolean;
  isUSDC: boolean;
  explorerUrl: string;
}

type PaymentOp = Horizon.HorizonApi.PaymentOperationResponse & {
  to?: string;
  asset_code?: string;
  asset_issuer?: string;
  amount?: string;
};

export class StellarService {
  private getServer(network: 'testnet' | 'mainnet'): Horizon.Server {
    const url =
      network === 'mainnet'
        ? 'https://horizon.stellar.org'
        : (process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org');
    return new Horizon.Server(url, { allowHttp: false });
  }

  getExplorerUrl(hash: string, network: 'testnet' | 'mainnet'): string {
    const base = network === 'mainnet'
      ? 'https://stellar.expert/explorer/public/tx'
      : 'https://stellar.expert/explorer/testnet/tx';
    return `${base}/${hash}`;
  }

  /**
   * Independently verify a Stellar transaction via Horizon.
   * Client-supplied data is NEVER trusted — all details come from the network.
   */
  async verifyTransaction(
    hash: string,
    network: 'testnet' | 'mainnet' = 'testnet'
  ): Promise<VerifiedTransaction | null> {
    try {
      const server = this.getServer(network);
      const tx = await server.transactions().transaction(hash).call();

      if (!tx.successful) {
        logger.warn('Stellar transaction not successful', { hash, network });
        return null;
      }

      const operations = await server.operations().forTransaction(hash).call();

      const paymentOp = operations.records.find(
        (op) => op.type === 'payment'
      ) as PaymentOp | undefined;

      if (!paymentOp) {
        logger.warn('No payment operation in transaction', { hash });
        return null;
      }

      const assetCode = paymentOp.asset_type === 'native'
        ? 'XLM'
        : (paymentOp.asset_code || 'UNKNOWN');

      const assetIssuer = paymentOp.asset_type === 'native'
        ? ''
        : (paymentOp.asset_issuer || '');

      const isUSDC = this.isUSDC(assetCode, assetIssuer, network);

      let memo: string | null = null;
      if (tx.memo_type === 'text' && tx.memo) memo = tx.memo;
      else if (tx.memo_type === 'id' && tx.memo) memo = tx.memo;

      // Ledger is returned as a number from the Horizon API
      const ledgerNum = typeof tx.ledger === 'number'
        ? tx.ledger
        : parseInt(String(tx.ledger), 10);

      return {
        hash: tx.hash,
        network,
        ledger: ledgerNum,
        sourceAccount: tx.source_account,
        destinationAccount: paymentOp.to || '',
        assetCode,
        assetIssuer,
        amount: paymentOp.amount || '0',
        memo,
        createdAt: tx.created_at,
        successful: tx.successful,
        isUSDC,
        explorerUrl: this.getExplorerUrl(hash, network),
      };
    } catch (error: unknown) {
      const httpError = error as { response?: { status?: number } };
      if (httpError?.response?.status === 404) {
        return null;
      }
      logger.error('Stellar transaction verification failed', {
        hash,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new StellarError(
        `Failed to verify transaction: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Verify USDC asset with correct issuer.
   * Never trust the asset code alone — always verify the issuer address.
   */
  isUSDC(assetCode: string, assetIssuer: string, network: 'testnet' | 'mainnet'): boolean {
    return assetCode === 'USDC' && assetIssuer === USDC_ISSUERS[network];
  }

  async getAccountInfo(
    publicKey: string,
    network: 'testnet' | 'mainnet' = 'testnet'
  ): Promise<boolean> {
    try {
      const server = this.getServer(network);
      await server.loadAccount(publicKey);
      return true;
    } catch (error: unknown) {
      const httpError = error as { response?: { status?: number } };
      if (httpError?.response?.status === 404) return false;
      throw new StellarError(
        `Failed to load account: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async getAccountTransactions(
    publicKey: string,
    network: 'testnet' | 'mainnet' = 'testnet',
    limit: number = 20
  ) {
    try {
      const server = this.getServer(network);
      const result = await server
        .transactions()
        .forAccount(publicKey)
        .order('desc')
        .limit(limit)
        .call();

      return result.records.map((tx) => ({
        hash: tx.hash,
        ledger: tx.ledger,
        createdAt: tx.created_at,
        successful: tx.successful,
        memoType: tx.memo_type,
        memo: tx.memo || null,
        explorerUrl: this.getExplorerUrl(tx.hash, network),
      }));
    } catch (error) {
      throw new StellarError(
        `Failed to fetch account transactions: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async pollPayments(
    publicKey: string,
    network: 'testnet' | 'mainnet' = 'testnet',
    cursor?: string
  ): Promise<{
    payments: PaymentOp[];
    nextCursor: string;
  }> {
    const server = this.getServer(network);

    let query = server
      .payments()
      .forAccount(publicKey)
      .order('asc')
      .limit(50);

    if (cursor) {
      query = query.cursor(cursor);
    }

    const result = await query.call();
    const payments = result.records.filter(
      (op) => op.type === 'payment'
    ) as PaymentOp[];

    const nextCursor =
      result.records.length > 0
        ? result.records[result.records.length - 1].paging_token
        : (cursor || '');

    return { payments, nextCursor };
  }
}
