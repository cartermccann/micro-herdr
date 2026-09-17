import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDispatcher, makeFocuser, makeHoldPress, chordToWtypeArgs, chordToHoldArgs } from "./dispatch.mjs";

const CURSOR = { name: "cursor", appid: "cursor", appidAliases: ["Cursor"], label: "Cursor" };

// A stub for the child_process seam: records calls, replies with whatever the
// test queued. Nothing here spawns wlrctl or wtype.
function fakeExec(results = {}) {
  const calls = [];
  const exec = (cmd, args, cb) => {
    calls.push({ cmd, args });
    setImmediate(() => cb(results[cmd] ?? null));
  };
  return { exec, calls, ran: (cmd) => calls.filter((c) => c.cmd === cmd).length };
}

test("chordToWtypeArgs and chordToHoldArgs keep their shape", () => {
  assert.deepEqual(chordToWtypeArgs("ctrl+d"), ["-M", "ctrl", "-k", "d", "-m", "ctrl"]);
  assert.deepEqual(chordToWtypeArgs("Return"), ["-k", "Return"]);
  assert.deepEqual(chordToHoldArgs("ctrl+d"), { down: ["-M", "ctrl", "-P", "d"], up: ["-p", "d", "-m", "ctrl"] });
});

test("already focused on the target: no wlrctl, chord goes straight out", (t, done) => {
  const f = fakeExec();
  const ensureFocus = makeFocuser({ getFocused: () => "cursor", exec: f.exec });
  ensureFocus(CURSOR, (err) => {
    assert.equal(err, null);
    assert.equal(f.ran("wlrctl"), 0);
    done();
  });
});

test("a differently-spelled app_id still counts as focused", (t, done) => {
  const f = fakeExec();
  const ensureFocus = makeFocuser({ getFocused: () => "Cursor", exec: f.exec });
  ensureFocus(CURSOR, (err) => {
    assert.equal(err, null);
    assert.equal(f.ran("wlrctl"), 0);
    done();
  });
});

test("focused elsewhere: wlrctl runs, and the callback waits for focus to land", (t, done) => {
  const f = fakeExec();
  let focused = "zen-beta";
  const ensureFocus = makeFocuser({ getFocused: () => focused, exec: f.exec, settleMs: 1, pollMs: 5 });
  ensureFocus(CURSOR, (err) => {
    assert.equal(err, null);
    assert.equal(f.ran("wlrctl"), 1);
    assert.deepEqual(f.calls[0].args.slice(0, 2), ["toplevel", "focus"]);
    assert.ok(f.calls[0].args.includes("app_id:cursor"));
    done();
  });
  setTimeout(() => { focused = "cursor"; }, 15);
});

test("focus never lands: error, so the caller can refuse to type", (t, done) => {
  const f = fakeExec();
  const ensureFocus = makeFocuser({ getFocused: () => "zen-beta", exec: f.exec, timeoutMs: 30, pollMs: 5 });
  ensureFocus(CURSOR, (err) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /did not land on Cursor/);
    done();
  });
});

test("wlrctl itself failing is an error, not a silent pass", (t, done) => {
  const f = fakeExec({ wlrctl: new Error("no toplevel matched") });
  const ensureFocus = makeFocuser({ getFocused: () => "zen-beta", exec: f.exec });
  ensureFocus(CURSOR, (err) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /could not focus Cursor/);
    done();
  });
});

test("dispatch sends the chord once focus is confirmed", (t, done) => {
  const f = fakeExec();
  const dispatch = makeDispatcher({
    exec: f.exec,
    ensureFocus: (_target, cb) => cb(null),
  });
  dispatch({ verb: "send", action: "Return", target: CURSOR, key: "ACT12" });
  setImmediate(() => {
    assert.equal(f.ran("wtype"), 1);
    assert.deepEqual(f.calls[0].args, ["-k", "Return"]);
    done();
  });
});

test("dispatch does NOT type when focus could not be established", (t, done) => {
  const f = fakeExec();
  const logs = [];
  const dispatch = makeDispatcher({
    exec: f.exec,
    log: (m) => logs.push(m),
    ensureFocus: (_target, cb) => cb(new Error("focus did not land on Cursor (still zen-beta)")),
  });
  dispatch({ verb: "send", action: "Return", target: CURSOR, key: "ACT12" });
  setImmediate(() => {
    assert.equal(f.ran("wtype"), 0, "a chord must never land in the wrong window");
    assert.ok(logs.some((l) => l.includes("focus did not land")));
    done();
  });
});

test("focus: and shell: verbs do not go through ensureFocus", (t, done) => {
  const f = fakeExec();
  let asked = 0;
  const dispatch = makeDispatcher({
    exec: f.exec,
    ensureFocus: (_t, cb) => { asked += 1; cb(null); },
  });
  dispatch({ verb: "focus:cursor", action: "focus:cursor", target: null, key: "AG00" });
  dispatch({ verb: "shell:x", action: "shell:true", target: null, key: "AG05" });
  setImmediate(() => {
    assert.equal(asked, 0);
    assert.equal(f.ran("wlrctl"), 1);
    assert.equal(f.ran("/bin/sh"), 1);
    done();
  });
});

test("an undefined verb types nothing at all", (t, done) => {
  const f = fakeExec();
  const dispatch = makeDispatcher({ exec: f.exec, ensureFocus: (_t, cb) => cb(null) });
  dispatch({ verb: "approve", action: null, target: CURSOR, key: "ACT07" });
  setImmediate(() => {
    assert.equal(f.calls.length, 0);
    done();
  });
});

// --- no focus signal -------------------------------------------------------
// Before the watcher has seen its first focus change, getFocused() is null.
// That is a real window on a healthy machine, not just a missing backend, so
// the raise must still go out; only the confirmation is skipped.

test("no focus signal still raises the target, it just cannot confirm", (t, done) => {
  const f = fakeExec();
  const ensureFocus = makeFocuser({ getFocused: () => null, exec: f.exec, settleMs: 1 });
  ensureFocus(CURSOR, (err) => {
    assert.equal(err, null);
    assert.equal(f.ran("wlrctl"), 1, "the raise must be attempted, not skipped");
    done();
  });
});

test("no focus signal and a failed raise still sends, rather than swallowing", (t, done) => {
  const f = fakeExec({ wlrctl: new Error("no toplevel matched") });
  const ensureFocus = makeFocuser({ getFocused: () => null, exec: f.exec });
  ensureFocus(CURSOR, (err) => {
    assert.equal(err, null);
    done();
  });
});

// --- hold-to-talk ----------------------------------------------------------

test("hold: down focuses then presses, up releases", (t, done) => {
  const f = fakeExec();
  const hold = makeHoldPress({ ensureFocus: (_t, cb) => cb(null), exec: f.exec });
  hold.down(CURSOR, "ctrl+d", "ACT10");
  setImmediate(() => {
    assert.deepEqual(f.calls.map((c) => c.args), [["-M", "ctrl", "-P", "d"]]);
    assert.equal(hold.isHeld, true);
    hold.up("ACT10");
    setImmediate(() => {
      assert.deepEqual(f.calls.at(-1).args, ["-p", "d", "-m", "ctrl"]);
      assert.equal(hold.isHeld, false);
      done();
    });
  });
});

test("hold: releasing before focus lands sends NOTHING, leaving no phantom key", (t, done) => {
  const f = fakeExec();
  let land = null;
  const hold = makeHoldPress({ ensureFocus: (_t, cb) => { land = cb; }, exec: f.exec });

  hold.down(CURSOR, "ctrl+d", "ACT10");   // focus is still in flight
  hold.up("ACT10");                        // released first
  land(null);                              // focus lands afterwards

  setImmediate(() => {
    assert.equal(f.calls.length, 0, "a press must never outlive its release");
    assert.equal(hold.isHeld, false);
    done();
  });
});

test("hold: a failed focus on the down edge presses nothing and holds nothing", (t, done) => {
  const f = fakeExec();
  const hold = makeHoldPress({ ensureFocus: (_t, cb) => cb(new Error("focus did not land on Cursor")), exec: f.exec });
  hold.down(CURSOR, "ctrl+d", "ACT10");
  setImmediate(() => {
    assert.equal(f.calls.length, 0);
    assert.equal(hold.isHeld, false);
    hold.up("ACT10");
    setImmediate(() => { assert.equal(f.calls.length, 0); done(); });
  });
});

test("hold: the release goes out even when its focus attempt fails", (t, done) => {
  const f = fakeExec();
  let first = true;
  const hold = makeHoldPress({
    ensureFocus: (_t, cb) => { const ok = first; first = false; cb(ok ? null : new Error("focus did not land")); },
    exec: f.exec,
  });
  hold.down(CURSOR, "ctrl+d", "ACT10");
  setImmediate(() => {
    hold.up("ACT10");
    setImmediate(() => {
      assert.deepEqual(f.calls.at(-1).args, ["-p", "d", "-m", "ctrl"], "a key left down is worse than a stray release");
      done();
    });
  });
});

test("hold: reset drops the held press without sending a release", (t, done) => {
  const f = fakeExec();
  const hold = makeHoldPress({ ensureFocus: (_t, cb) => cb(null), exec: f.exec });
  hold.down(CURSOR, "ctrl+d", "ACT10");
  setImmediate(() => {
    hold.reset();
    assert.equal(hold.isHeld, false);
    const after = f.calls.length;
    hold.up("ACT10");
    setImmediate(() => { assert.equal(f.calls.length, after); done(); });
  });
});
