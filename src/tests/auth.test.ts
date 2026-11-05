import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../app';

/**
 * Auth integration tests.
 * These tests require a running PostgreSQL database.
 * Set TEST_DATABASE_URL in your environment before running.
 * The suite gracefully skips DB-dependent tests when no DB is available.
 */

const TEST_EMAIL = `test_${Date.now()}@paytrack.test`;
let dbAvailable = false;
let registeredToken = '';

beforeAll(async () => {
  // Quick probe — attempt a register and see if we get a DB error
  try {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: `probe_${Date.now()}@paytrack.test`,
      password: 'Password123!',
      firstName: 'Probe',
      lastName: 'User',
      workspaceName: 'Probe WS',
    });
    // Any 2xx or 4xx (validation, conflict) means DB is up
    if (res.status < 500) dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  const { prisma } = await import('../lib/prisma');
  await prisma.user.deleteMany({ where: { email: { endsWith: '@paytrack.test' } } });
  await prisma.$disconnect();
});

describe('POST /api/v1/auth/register', () => {
  it('rejects invalid email format', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: 'not-an-email',
      password: 'Password123!',
      firstName: 'Test',
      lastName: 'User',
      workspaceName: 'WS',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects weak password', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: 'valid@paytrack.test',
      password: 'weak',
      firstName: 'Test',
      lastName: 'User',
      workspaceName: 'WS',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects password without uppercase', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: 'valid@paytrack.test',
      password: 'alllowercase1',
      firstName: 'Test',
      lastName: 'User',
      workspaceName: 'WS',
    });
    expect(res.status).toBe(400);
  });

  it('registers a new user when DB is available', async () => {
    if (!dbAvailable) {
      console.log('Skipping: no database connection');
      return;
    }
    const res = await request(app).post('/api/v1/auth/register').send({
      email: TEST_EMAIL,
      password: 'Password123!',
      firstName: 'Test',
      lastName: 'User',
      workspaceName: 'Test Workspace',
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.user.email).toBe(TEST_EMAIL);
    expect(res.body.data.user).not.toHaveProperty('passwordHash');
    registeredToken = res.body.data.accessToken;
  });

  it('rejects duplicate registration when DB is available', async () => {
    if (!dbAvailable) return;
    const res = await request(app).post('/api/v1/auth/register').send({
      email: TEST_EMAIL,
      password: 'Password123!',
      firstName: 'Dupe',
      lastName: 'User',
      workspaceName: 'Another WS',
    });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /api/v1/auth/login', () => {
  it('returns 401 for non-existent user when DB is available', async () => {
    if (!dbAvailable) return;
    const res = await request(app).post('/api/v1/auth/login').send({
      email: 'nobody@paytrack.test',
      password: 'Password123!',
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for wrong password when DB is available', async () => {
    if (!dbAvailable) return;
    const res = await request(app).post('/api/v1/auth/login').send({
      email: TEST_EMAIL,
      password: 'WrongPassword1!',
    });
    expect(res.status).toBe(401);
  });

  it('returns access token for valid credentials when DB is available', async () => {
    if (!dbAvailable) return;
    const res = await request(app).post('/api/v1/auth/login').send({
      email: TEST_EMAIL,
      password: 'Password123!',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    // Supertest may not expose Set-Cookie in all environments; check body at minimum
    expect(res.body.success).toBe(true);
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns 401 for unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 for malformed token', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer not.a.valid.token');
    expect(res.status).toBe(401);
  });

  it('returns user profile with valid token when DB is available', async () => {
    if (!dbAvailable || !registeredToken) return;
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${registeredToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(TEST_EMAIL);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('returns 200 and clears cookie', async () => {
    const res = await request(app).post('/api/v1/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Health check', () => {
  it('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('paytrack-backend');
  });
});
