import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    users: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    tenants: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn(),
  },
}));

jest.mock('../lib/email', () => ({
  sendWelcomeEmail: jest.fn().mockResolvedValue(undefined),
  sendNewRegistrationNotification: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
  sendTeamMemberJoinedEmail: jest.fn().mockResolvedValue(undefined),
  sendEmailVerificationEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/cache', () => ({ tenantCache: { set: jest.fn(), get: jest.fn() } }));

jest.mock('../lib/auditLog', () => ({ logAudit: jest.fn() }));

jest.mock('../lib/validation', () => {
  const passthrough = (_schema: any) => (_req: any, _res: any, next: any) => next();
  return {
    validate: passthrough,
    registerSchema: {},
    loginSchema: {},
    setPasswordSchema: {},
    forgotPasswordSchema: {},
    resetPasswordSchema: {},
  };
});

jest.mock('../middleware/errorHandler', () => ({
  safeError: (res: any, _err: any, _ctx: string) => res.status(500).json({ error: 'Internal error' }),
}));

jest.mock('./mfa', () => ({
  generateAndSendEmailOtp: jest.fn().mockResolvedValue(undefined),
  verifyEmailOtp: jest.fn().mockResolvedValue(true),
  verifyTotp: jest.fn().mockReturnValue(true),
  verifyBackupCode: jest.fn().mockResolvedValue(false),
}));

jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed_password'),
  compare: jest.fn().mockResolvedValue(true),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

process.env.JWT_SECRET = 'test-secret';

const prisma = require('../lib/prisma').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  app.use('/api/auth', require('./auth').default);
  return app;
}

function makeToken(payload = {}) {
  return jwt.sign({ userId: 'user-1', tenantId: 'tenant-1', role: 'owner', email: 'test@corp.com', ...payload }, 'test-secret');
}

function makeUser(overrides = {}) {
  return {
    id: 'user-1',
    email: 'test@corp.com',
    name: 'Test User',
    role: 'owner',
    password_hash: 'hashed_password',
    tenant_id: 'tenant-1',
    permissions: {},
    profile_image: null,
    email_verified: true,
    mfa_enabled: false,
    mfa_method: null,
    mfa_secret: null,
    tenants: { id: 'tenant-1', name: 'Corp', plan: 'pro', subscription_status: 'active', trial_ends_at: null, custom_features: {} },
    ...overrides,
  };
}

// Stub createAuthToken / consumeAuthToken at the raw DB level
function stubCreateToken() {
  prisma.$executeRaw.mockResolvedValue(1);
  prisma.$queryRaw.mockResolvedValue([]);
}

function stubConsumeToken(result: { userId: string; metadata: Record<string, any> } | null) {
  // First $queryRaw for SELECT, then $executeRaw for UPDATE
  prisma.$queryRaw.mockResolvedValueOnce(
    result
      ? [{ id: 'tok-1', user_id: result.userId, metadata: result.metadata, expires_at: new Date(Date.now() + 60000) }]
      : []
  );
  prisma.$executeRaw.mockResolvedValue(1);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/auth/register', () => {
  let app: express.Express;
  beforeEach(() => {
    app = makeApp();
    jest.clearAllMocks();
    stubCreateToken();
  });

  it('creates a new user and tenant (happy path)', async () => {
    prisma.users.findUnique.mockResolvedValue(null);
    prisma.users.findFirst.mockResolvedValue(null); // no domain conflict
    prisma.tenants.create.mockResolvedValue({ id: 'tenant-1', name: 'Acme', trial_ends_at: new Date() });
    prisma.users.create.mockResolvedValue(makeUser());

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'alice@acme.com', password: 'Password1!', name: 'Alice', companyName: 'Acme' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.emailVerificationRequired).toBe(true);
  });

  it('returns 400 when email is already registered', async () => {
    prisma.users.findUnique.mockResolvedValue(makeUser());
    prisma.users.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@corp.com', password: 'Password1!', name: 'Dupe', companyName: 'Corp' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already registered/i);
  });

  it('returns 409 when domain belongs to an existing workspace', async () => {
    prisma.users.findUnique.mockResolvedValue(null);
    prisma.users.findFirst.mockResolvedValue({ id: 'other-owner' }); // domain conflict

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'bob@existing.com', password: 'Password1!', name: 'Bob', companyName: 'Existing Corp' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/workspace already exists/i);
  });
});

describe('GET /api/auth/verify-email', () => {
  let app: express.Express;
  beforeEach(() => { app = makeApp(); jest.clearAllMocks(); });

  it('verifies email with a valid token', async () => {
    stubConsumeToken({ userId: 'user-1', metadata: {} });
    prisma.users.update.mockResolvedValue(makeUser({ email_verified: true }));

    const res = await request(app).get('/api/auth/verify-email?token=validtoken123');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 400 when token is missing', async () => {
    const res = await request(app).get('/api/auth/verify-email');
    expect(res.status).toBe(400);
  });

  it('returns 400 when token is invalid or expired', async () => {
    stubConsumeToken(null);

    const res = await request(app).get('/api/auth/verify-email?token=badtoken');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid or expired/i);
  });
});

describe('POST /api/auth/resend-verification', () => {
  let app: express.Express;
  beforeEach(() => { app = makeApp(); jest.clearAllMocks(); stubCreateToken(); });

  it('sends a new verification link for a pending user', async () => {
    prisma.users.findUnique.mockResolvedValue(makeUser({ email_verified: false }));

    const res = await request(app)
      .post('/api/auth/resend-verification')
      .send({ email: 'test@corp.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 400 when email is not provided', async () => {
    const res = await request(app).post('/api/auth/resend-verification').send({});
    expect(res.status).toBe(400);
  });

  it('returns generic success even for unknown emails (prevents enumeration)', async () => {
    prisma.users.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/resend-verification')
      .send({ email: 'nobody@nowhere.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /api/auth/login', () => {
  let app: express.Express;
  beforeEach(() => { app = makeApp(); jest.clearAllMocks(); stubCreateToken(); });

  it('returns a JWT on successful login', async () => {
    prisma.users.findUnique.mockResolvedValue(makeUser());

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@corp.com', password: 'Password1!' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.email).toBe('test@corp.com');
  });

  it('returns 401 for invalid credentials', async () => {
    const bcrypt = require('bcryptjs');
    bcrypt.compare.mockResolvedValueOnce(false);
    prisma.users.findUnique.mockResolvedValue(makeUser());

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@corp.com', password: 'wrong' });

    expect(res.status).toBe(401);
  });

  it('returns 401 when user not found', async () => {
    prisma.users.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@corp.com', password: 'Password1!' });

    expect(res.status).toBe(401);
  });

  it('returns 403 when email is not verified', async () => {
    prisma.users.findUnique.mockResolvedValue(makeUser({ email_verified: false }));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@corp.com', password: 'Password1!' });

    expect(res.status).toBe(403);
    expect(res.body.emailVerificationRequired).toBe(true);
  });

  it('returns mfaPending when MFA is enabled', async () => {
    prisma.users.findUnique.mockResolvedValue(makeUser({ mfa_enabled: true, mfa_method: 'totp' }));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@corp.com', password: 'Password1!' });

    expect(res.status).toBe(200);
    expect(res.body.mfaPending).toBe(true);
    expect(res.body.mfaToken).toBeDefined();
  });
});

describe('POST /api/auth/mfa-verify', () => {
  let app: express.Express;
  beforeEach(() => { app = makeApp(); jest.clearAllMocks(); });

  it('returns a JWT when MFA code is valid', async () => {
    stubConsumeToken({ userId: 'user-1', metadata: { email: 'test@corp.com', tenantId: 'tenant-1' } });
    prisma.users.findUnique.mockResolvedValue(makeUser({ mfa_enabled: true, mfa_method: 'totp', mfa_secret: 'TOTP_SECRET' }));

    const res = await request(app)
      .post('/api/auth/mfa-verify')
      .send({ mfaToken: 'valid-mfa-token', mfaCode: '123456' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  it('returns 400 when mfaToken or mfaCode is missing', async () => {
    const res = await request(app)
      .post('/api/auth/mfa-verify')
      .send({ mfaToken: 'tok' });

    expect(res.status).toBe(400);
  });

  it('returns 401 when MFA session is expired', async () => {
    stubConsumeToken(null);

    const res = await request(app)
      .post('/api/auth/mfa-verify')
      .send({ mfaToken: 'expired', mfaCode: '000000' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });
});

describe('POST /api/auth/set-password', () => {
  let app: express.Express;
  beforeEach(() => { app = makeApp(); jest.clearAllMocks(); });

  it('sets password for invited user and returns JWT', async () => {
    prisma.users.findUnique.mockResolvedValue(makeUser({ password_hash: null }));
    prisma.users.update.mockResolvedValue(makeUser());

    const res = await request(app)
      .post('/api/auth/set-password')
      .send({ email: 'test@corp.com', password: 'NewPass1!' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  it('returns 404 when email has no invitation', async () => {
    prisma.users.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/set-password')
      .send({ email: 'ghost@corp.com', password: 'NewPass1!' });

    expect(res.status).toBe(404);
  });

  it('returns 400 when password is already set', async () => {
    prisma.users.findUnique.mockResolvedValue(makeUser()); // has password_hash

    const res = await request(app)
      .post('/api/auth/set-password')
      .send({ email: 'test@corp.com', password: 'NewPass1!' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already set/i);
  });
});

describe('POST /api/auth/forgot-password', () => {
  let app: express.Express;
  beforeEach(() => { app = makeApp(); jest.clearAllMocks(); stubCreateToken(); });

  it('sends a reset email for a registered user', async () => {
    prisma.users.findUnique.mockResolvedValue(makeUser());

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'test@corp.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns generic success for unknown email (prevents enumeration)', async () => {
    prisma.users.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'nobody@corp.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /api/auth/reset-password', () => {
  let app: express.Express;
  beforeEach(() => { app = makeApp(); jest.clearAllMocks(); });

  it('resets password and returns a JWT', async () => {
    stubConsumeToken({ userId: 'user-1', metadata: { email: 'test@corp.com' } });
    prisma.users.findUnique.mockResolvedValue(makeUser());
    prisma.users.update.mockResolvedValue(makeUser());

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'valid-reset-token', email: 'test@corp.com', password: 'NewPass1!' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
  });

  it('returns 400 for invalid or expired reset token', async () => {
    stubConsumeToken(null);

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'bad-token', email: 'test@corp.com', password: 'NewPass1!' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid or expired/i);
  });

  it('returns 400 when token email does not match request email', async () => {
    stubConsumeToken({ userId: 'user-1', metadata: { email: 'other@corp.com' } });

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'valid-token', email: 'test@corp.com', password: 'NewPass1!' });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/auth/me', () => {
  let app: express.Express;
  beforeEach(() => { app = makeApp(); jest.clearAllMocks(); });

  it('returns the authenticated user profile', async () => {
    prisma.users.findUnique.mockResolvedValue(makeUser());

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.email).toBe('test@corp.com');
    expect(res.body.tenant).toBeDefined();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 for an invalid JWT', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not.a.real.token');

    expect(res.status).toBe(401);
  });
});

describe('PUT /api/auth/me', () => {
  let app: express.Express;
  beforeEach(() => { app = makeApp(); jest.clearAllMocks(); });

  it('updates name and profile_image', async () => {
    prisma.users.update.mockResolvedValue(makeUser({ name: 'New Name' }));

    const res = await request(app)
      .put('/api/auth/me')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await request(app).put('/api/auth/me').send({ name: 'X' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when no updatable fields are provided', async () => {
    const res = await request(app)
      .put('/api/auth/me')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nothing to update/i);
  });
});
