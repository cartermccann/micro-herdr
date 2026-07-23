// micro-herdr PROBE — connect to the Codex Micro over BLE-HID via the WL kit and
// log EVERY device->host notify with its full payload. This is the recon step:
// press each key/dial/joystick and read what wire event it produces.
//
// Assumes the Micro is already BLE-connected (so /dev/hidrawN exists). Run:
//   node probe.mjs
// then press controls. Ctrl-C to stop.
import { KIT_PATH, resolveMac, makeLogger, NOTIFY_METHODS } from "./lib/kit.mjs";
import { execFile } from "node:child_process";

const { WLDeviceDiscovery, WLDeviceCommImpl, ConnectionType } = await import(KIT_PATH);
const log = makeLogger();
const MAC = resolveMac();

const ts = () => new Date().toISOString().slice(11, 23);
function event(method, params) {
  console.log(`\n[${ts()}] ⇐ ${method}`);
  console.log("   params:", JSON.stringify(params));
}

// Best-effort BLE connect (device sleeps; nudge it so the hidraw node appears).
function bleConnect() {
  return new Promise((res) => {
    execFile("bluetoothctl", ["connect", MAC], { timeout: 15000 }, () => res());
  });
}

async function findMicro() {
  const disc = new WLDeviceDiscovery(log);
  const devices = await Promise.resolve(disc.findWLDevices());
  return devices.find((d) => d.deviceType === "codex_micro") || devices[0];
}

async function run() {
  console.log("micro-herdr probe — waiting for the Codex Micro (BLE)…");
  let comm;
  for (;;) {
    let dev = await findMicro();
    if (!dev) {
      await bleConnect();
      await new Promise((r) => setTimeout(r, 2000));
      dev = await findMicro();
    }
    if (!dev) {
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    console.log(`\nfound ${dev.deviceType} @ ${dev.portPath} (pid ${dev.devicePid})`);
    comm = new WLDeviceCommImpl(log);

    let disconnected = false;
    comm.onConnectionEvent((e) => {
      const T = ["CONNECTED", "DISCONNECTED", "ERROR"][e.type] ?? e.type;
      console.log(`[${ts()}] link: ${T}${e.error ? " " + e.error : ""}`);
      if (T !== "CONNECTED") disconnected = true;
    });

    const ok = await comm.connect(dev).catch((e) => {
      console.log("connect failed:", e.message);
      return false;
    });
    if (!ok) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    for (const m of NOTIFY_METHODS) comm.addNotifyHandler(m, (params) => event(m, params));
    console.log(`\n✅ connected. Registered ${NOTIFY_METHODS.length} handlers.`);
    console.log(">>> PRESS EACH CONTROL NOW — one at a time. (MHDEBUG=1 also shows unknown methods.)\n");

    // Optional: ask the device its status so we confirm the RPC channel both ways.
    try {
      const { WLRPCApi } = await import(KIT_PATH);
      const rpc = new WLRPCApi(comm, log);
      const status = await rpc.getRpcClient().sendRpcCall({ method: "device.status" }).catch(() => null);
      if (status) console.log("device.status:", JSON.stringify(status.result ?? status));
    } catch {}

    while (!disconnected) await new Promise((r) => setTimeout(r, 500));
    console.log("disconnected — rediscovering…");
    try { await comm.disconnect(); } catch {}
  }
}

process.on("SIGINT", () => { console.log("\nbye"); process.exit(0); });
run().catch((e) => { console.error("fatal:", e); process.exit(1); });
