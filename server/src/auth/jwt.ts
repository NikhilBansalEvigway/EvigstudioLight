import { SignJWT, jwtVerify } from 'jose';

const COOKIE_NAME = 'scribe_session';

function getSecret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    throw new Error('JWT_SECRET must be set to a string at least 16 characters');
  }
  return new TextEncoder().encode(s);
}

export type SessionPayload = {
  sub: string;
  email: string;
  role: string;
  iat?: number;
  exp?: number;
};

export async function signSession(payload: Omit<SessionPayload, 'iat' | 'exp'>): Promise<string> {
  return new SignJWT({ email: payload.email, role: payload.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(getSecret());
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    const email = typeof payload.email === 'string' ? payload.email : '';
    const role = typeof payload.role === 'string' ? payload.role : 'developer';
    if (!sub) return null;
    return { sub, email, role };
  } catch {
    return null;
  }
}

export { COOKIE_NAME };
