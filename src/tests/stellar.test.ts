import { describe, it, expect, vi } from 'vitest';
import { StellarService, USDC_ISSUERS } from '../services/stellar/stellar.service';

// Mock the Stellar SDK to avoid network calls in unit tests
vi.mock('@stellar/stellar-sdk', () => {
  const mockTransaction = {
    hash: 'mockTxHash123',
    successful: true,
    ledger: 50000,
    source_account: 'GSOURCE00000000000000000000000000000000000000000000000001',
    created_at: '2024-01-15T10:00:00Z',
    memo_type: 'text',
    memo: 'INV-2024-0001',
  };

  const mockPaymentOp = {
    type: 'payment',
    to: 'GDEST000000000000000000000000000000000000000000000000001',
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    amount: '150.0000000',
    paging_token: 'cursor123',
    transaction_hash: 'mockTxHash123',
  };

  return {
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        transactions: () => ({
          transaction: () => ({ call: async () => mockTransaction }),
          forAccount: () => ({
            order: () => ({ limit: () => ({ call: async () => ({ records: [mockTransaction] }) }) }),
          }),
        }),
        operations: () => ({
          forTransaction: () => ({
            call: async () => ({ records: [mockPaymentOp] }),
          }),
        }),
        payments: () => ({
          forAccount: () => ({
            order: () => ({
              limit: () => ({
                cursor: () => ({
                  call: async () => ({
                    records: [mockPaymentOp],
                  }),
                }),
              }),
            }),
          }),
        }),
        loadAccount: async () => ({
          id: 'GDEST000000000000000000000000000000000000000000000000001',
          balances: [],
        }),
      })),
    },
    Networks: { TESTNET: 'Test SDF Network ; September 2015' },
    Asset: vi.fn(),
  };
});

describe('StellarService', () => {
  const service = new StellarService();

  describe('isUSDC', () => {
    it('returns true for USDC with correct testnet issuer', () => {
      expect(service.isUSDC('USDC', USDC_ISSUERS.testnet, 'testnet')).toBe(true);
    });

    it('returns false for USDC with wrong issuer', () => {
      expect(service.isUSDC('USDC', 'GWRONGISSUER123', 'testnet')).toBe(false);
    });

    it('returns false for non-USDC asset even with correct issuer', () => {
      expect(service.isUSDC('USDT', USDC_ISSUERS.testnet, 'testnet')).toBe(false);
    });

    it('returns false for native XLM', () => {
      expect(service.isUSDC('XLM', '', 'testnet')).toBe(false);
    });

    it('uses different issuers for testnet vs mainnet', () => {
      // Testnet issuer should not work for mainnet
      expect(service.isUSDC('USDC', USDC_ISSUERS.testnet, 'mainnet')).toBe(false);
      expect(service.isUSDC('USDC', USDC_ISSUERS.mainnet, 'mainnet')).toBe(true);
    });
  });

  describe('verifyTransaction', () => {
    it('returns a verified transaction for a valid hash', async () => {
      const result = await service.verifyTransaction('mockTxHash123', 'testnet');
      expect(result).not.toBeNull();
      expect(result?.hash).toBe('mockTxHash123');
      expect(result?.successful).toBe(true);
      expect(result?.assetCode).toBe('USDC');
      expect(result?.amount).toBe('150.0000000');
    });

    it('returns null for a 404 transaction', async () => {
      const { Horizon } = await import('@stellar/stellar-sdk');
      const MockServer = vi.mocked(Horizon.Server);
      MockServer.mockImplementationOnce(() => ({
        transactions: () => ({
          transaction: () => ({
            call: async () => { throw { response: { status: 404 } }; },
          }),
          forAccount: () => ({ order: () => ({ limit: () => ({ call: async () => ({ records: [] }) }) }) }),
        }),
        operations: () => ({ forTransaction: () => ({ call: async () => ({ records: [] }) }) }),
        payments: () => ({ forAccount: () => ({ order: () => ({ limit: () => ({ cursor: () => ({ call: async () => ({ records: [] }) }) }) }) }) }),
        loadAccount: async () => null,
      }) as never);

      const result = await service.verifyTransaction('nonexistent_hash', 'testnet');
      expect(result).toBeNull();
    });
  });

  describe('getExplorerUrl', () => {
    it('returns testnet explorer URL', () => {
      const url = service.getExplorerUrl('abc123', 'testnet');
      expect(url).toContain('testnet');
      expect(url).toContain('abc123');
    });

    it('returns mainnet explorer URL', () => {
      const url = service.getExplorerUrl('abc123', 'mainnet');
      expect(url).toContain('public');
      expect(url).toContain('abc123');
    });
  });

  describe('getAccountInfo', () => {
    it('returns account info for existing account', async () => {
      const info = await service.getAccountInfo(
        'GDEST000000000000000000000000000000000000000000000000001',
        'testnet'
      );
      expect(info).not.toBeNull();
    });
  });
});
