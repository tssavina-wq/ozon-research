#!/usr/bin/env node
import { spawn } from "node:child_process";
import readline from "node:readline";

const py = spawn("python3", ["python/browser_service.py"], { stdio: ["pipe", "pipe", "inherit"] });
const rl = readline.createInterface({ input: py.stdout });
let id = 1;
const pending = new Map();
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});
function call(cmd, payload = {}) {
  const reqId = id++;
  return new Promise((resolve) => {
    pending.set(reqId, resolve);
    py.stdin.write(JSON.stringify({ id: reqId, cmd, ...payload }) + "\n");
  });
}

const search = await call("search_cities", { query: "Санкт", limit: 5 });
console.log("search_cities:", JSON.stringify(search.data, null, 2));
if (!search.ok || search.data.count < 1) process.exit(1);

const spb = search.data.cities.find((c) => c.city.includes("Санкт"));
if (!spb) process.exit(1);

const setRes = await call("set_city", { city: spb.city, lat: spb.lat, lng: spb.lng });
console.log("set_city:", JSON.stringify(setRes.data, null, 2));
await call("shutdown");
py.kill();
process.exit(setRes.ok ? 0 : 1);
