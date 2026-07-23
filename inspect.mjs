// micro-herdr INSPECT — one-shot: connect, dump the device filesystem and read
// its keymap / smart-action config, then exit. Answers "are keys configured?"
// without touching the hardware.
import { KIT_PATH, resolveMac, makeLogger } from "./lib/kit.mjs";
import { execFile } from "node:child_process";

const { WLDeviceDiscovery, WLDeviceCommImpl, WLRPCApi } = await import(KIT_PATH);
const log = makeLogger();
const MAC = resolveMac();

const ble = () => new Promise((r) => execFile("bluetoothctl", ["connect", MAC], { timeout: 15000 }, () => r()));

async function main() {
  const disc = new WLDeviceDiscovery(log);
  let dev;
  for (let i = 0; i < 10 && !dev; i++) {
    const list = await Promise.resolve(disc.findWLDevices());
    dev = list.find((d) => d.deviceType === "codex_micro") || list[0];
    if (!dev) { await ble(); await new Promise((r) => setTimeout(r, 2000)); }
  }
  if (!dev) { console.log("device not found — wake it and retry"); process.exit(1); }
  console.log("device:", dev.portPath, dev.deviceType);

  const comm = new WLDeviceCommImpl(log);
  if (!(await comm.connect(dev))) { console.log("connect failed"); process.exit(1); }
  const rpc = new WLRPCApi(comm, log);
  const client = rpc.getRpcClient();
  const call = async (method, params = null) => {
    try { const r = await client.sendRpcCall({ method, params }); return r.result ?? r; }
    catch (e) { return { error: String(e.message || e) }; }
  };

  console.log("\n=== device.status ===");
  console.log(await call("device.status"));

  console.log("\n=== fs.list ===");
  const files = await call("fs.list");
  console.log(JSON.stringify(files, null, 1));

  for (const f of files || []) {
    console.log(`\n=== readFile ${f.name} (${f.size}b) ===`);
    try {
      const data = await rpc.readFile(f.name);
      const s = typeof data === "string" ? data : JSON.stringify(data, null, 1);
      console.log(s.slice(0, 6000));
    } catch (e) { console.log("read error:", e.message); }
  }

  await comm.disconnect().catch(() => {});
  process.exit(0);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
