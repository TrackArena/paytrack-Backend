import dotenv from 'dotenv';
dotenv.config();
import app from './app';
import { prisma } from './lib/prisma';
import { logger } from './lib/logger';
import { TransactionMonitor } from './services/stellar/transactionMonitor';

const PORT = process.env.PORT || 3001;

async function main() {
  // Verify database connection
  try {
    await prisma.$connect();
    logger.info('Database connection established');
  } catch (error) {
    logger.error('Failed to connect to database', { error });
    process.exit(1);
  }

  // Start the HTTP server
  const server = app.listen(PORT, () => {
    logger.info(`PayTrack API server running on port ${PORT}`, {
      environment: process.env.NODE_ENV,
      network: process.env.STELLAR_NETWORK || 'testnet',
    });
  });

  // Start the Stellar transaction monitor (background worker)
  const monitor = new TransactionMonitor();
  monitor.start().catch((err) => {
    logger.error('Transaction monitor failed to start', { error: err });
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    monitor.stop();
    server.close(async () => {
      await prisma.$disconnect();
      logger.info('Server shut down');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  logger.error('Fatal startup error', { error });
  process.exit(1);
});
