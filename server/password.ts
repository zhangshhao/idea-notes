import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
function derive(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}
export const accountSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z][a-z0-9_-]{2,31}$/,
    "账号需为 3–32 位字母、数字、下划线或短横线，以字母开头",
  );
export const passwordSchema = z
  .string()
  .min(12, "密码至少需要 12 个字符")
  .max(128);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt);
  return `scrypt:${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(password: string, stored?: string) {
  const parts = stored?.split(":");
  const valid =
    parts?.[0] === "scrypt" &&
    /^[a-f0-9]{32}$/.test(parts[1]) &&
    /^[a-f0-9]{128}$/.test(parts[2]);
  const salt = valid ? parts![1] : "0".repeat(32);
  const expected = Buffer.from(valid ? parts![2] : "0".repeat(128), "hex");
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected) && !!valid;
}
