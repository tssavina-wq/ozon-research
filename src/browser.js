// Bridge to Python Camoufox browser service (anti-detect Firefox).

import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.OZON_PYTHON || "python3";
const SCRIPT = path.join(__dirname, "..", "python", "browser_service.py");

const log = (...a) => console.error("[browser]", ...a);

let proc = null;
let rl = null;
let nextId = 1;
const pending = new Map();

function rejectAll(reason) {
  for (const [, handlers] of pending) handlers.reject(reason);
  pending.clear();
}

function ensureProcess() {
  if (proc) return;

  log("starting Camoufox service…");
  proc = spawn(PYTHON, [SCRIPT], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env },
  });

  rl = readline.createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log("invalid JSON from python:", line.slice(0, 200));
      return;
    }

    const handlers = pending.get(msg.id);
    if (!handlers) return;
    pending.delete(msg.id);

    if (msg.ok) handlers.resolve(msg.data);
    else handlers.reject(new Error(msg.error || "browser service error"));
  });

  proc.on("exit", (code) => {
    log("python service exited", code);
    proc = null;
    rl = null;
    rejectAll(new Error("browser process exited"));
  });
}

function call(cmd, payload = {}) {
  ensureProcess();
  if (!proc?.stdin?.writable) {
    return Promise.reject(new Error("browser process is not writable"));
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      proc.stdin.write(JSON.stringify({ id, cmd, ...payload }) + "\n", (err) => {
        if (err) {
          pending.delete(id);
          reject(err);
        }
      });
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

/**
 * Fetch a composer-api page as parsed JSON for the given site path.
 * Delegates to Camoufox in python/browser_service.py.
 * Retries once if the Python process died mid-call (Connection closed / EPIPE).
 */
export async function fetchJson(path, { retries = 2 } = {}) {
  try {
    return await call("fetch", { path, retries });
  } catch (err) {
    const msg = err?.message || String(err);
    if (/exited|EPIPE|not writable|closed|destroyed/i.test(msg)) {
      log("browser bridge lost, restarting…");
      proc = null;
      rl = null;
      return call("fetch", { path, retries });
    }
    throw err;
  }
}

export async function warmup() {
  ensureProcess();
  return call("warmup");
}

export async function getLocation() {
  return call("get_location");
}

export async function searchCities(query, limit = 10) {
  return call("search_cities", { query, limit });
}

export async function setCity(city, { lat, lng } = {}) {
  const payload = { city };
  if (lat != null && lng != null) {
    payload.lat = lat;
    payload.lng = lng;
  }
  return call("set_city", payload);
}

export async function shutdown() {
  const child = proc;
  if (!child) return;

  try {
    await Promise.race([
      call("shutdown"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown timeout")), 8000)),
    ]);
  } catch (err) {
    log("shutdown:", err?.message);
  }

  await new Promise((resolve) => {
    if (child.exitCode != null || child.killed) return resolve();
    const timer = setTimeout(resolve, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      resolve();
    }
  });

  try {
    if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
  } catch {}

  if (proc === child) proc = null;
  rl?.close();
  rl = null;
  rejectAll(new Error("browser shut down"));
}
