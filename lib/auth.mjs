import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = "prospect_session";

export async function hashPassword(password) {
  const value = String(password || "");
  if (value.length < 10) throw new Error("Password must contain at least 10 characters.");
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(value, salt, 64);
  return `scrypt$${salt}$${Buffer.from(derived).toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [, salt, expectedHex] = String(stored || "").split("$");
  if (!salt || !expectedHex) return false;
  const actual = Buffer.from(await scrypt(String(password || ""), salt, 64));
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const hashToken = (token) => createHash("sha256").update(String(token || "")).digest("hex");

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || "").split(";").map((part) => part.trim().split(/=(.*)/s)).filter(([key]) => key));
}

export async function createLoginSession(store, user, response) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
  await store.createSession(hashToken(token), user.id, expiresAt.toISOString());
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${process.env.VERCEL ? "; Secure" : ""}`);
}

export async function currentUser(store, request) {
  const token = parseCookies(request)[SESSION_COOKIE];
  return token ? store.getSession(hashToken(token)) : null;
}

export async function logout(store, request, response) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (token) await store.deleteSession(hashToken(token));
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.VERCEL ? "; Secure" : ""}`);
}
