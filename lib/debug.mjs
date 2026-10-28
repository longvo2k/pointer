/**
 * Timing log for diagnosing slow or stalled commands.
 *
 *   POINTER_DEBUG=1             write to stderr
 *   POINTER_DEBUG=/tmp/p.log    append to that file (works for the background hub too)
 */
import { appendFileSync } from "node:fs";

const target = String(process.env.POINTER_DEBUG || "");

export const debugOn = target !== "" && target !== "0" && target !== "false";

export function debug(...parts) {
  if (!debugOn) return;
  const line = `${new Date().toISOString()} [pointer ${process.pid}] ${parts.join(" ")}\n`;
  try {
    if (target === "1" || target === "true") process.stderr.write(line);
    else appendFileSync(target, line);
  } catch {}
}

/** Ask the extension for step timings, and log the ones that come back. */
export function withDebug(params) {
  return debugOn ? { ...params, debug: true } : params;
}

export function logTrace(method, lines) {
  if (!debugOn || !Array.isArray(lines)) return;
  for (const line of lines) debug(`  ext ${method} ${line}`);
}

/** Time a promise and log how long it took and whether it failed. */
export async function timed(label, promise) {
  if (!debugOn) return promise;
  const started = Date.now();
  try {
    const out = await promise;
    debug(label, `${Date.now() - started}ms`);
    return out;
  } catch (err) {
    debug(label, `${Date.now() - started}ms failed: ${err?.message || err}`);
    throw err;
  }
}
