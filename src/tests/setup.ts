import * as dotenv from 'dotenv';
dotenv.config();

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test_access_secret_min_64_chars_long_abcdefghijklmnopqrstuvwxyz123';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_min_64_chars_long_abcdefghijklmnopqrstuvwxyz1';
process.env.JWT_ACCESS_EXPIRY = '15m';
process.env.JWT_REFRESH_EXPIRY = '7d';
process.env.STELLAR_NETWORK = 'testnet';
process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/paytrack_test';
