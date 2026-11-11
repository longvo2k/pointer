/**
 * Chrome profiles on this computer, read from Chrome's own files.
 *
 * Chrome lists every profile (open or not) in "<user data dir>/Local State".
 * Pointer saves a random instance id in each profile's extension storage, which
 * Chrome writes in plain text under "<profile>/Local Extension Settings/<id>/",
 * so a connected browser can be matched to its profile without opening a tab.
 * Reads only; never writes to Chrome's folders.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/** Where Google Chrome (stable) keeps its profiles. POINTER_CHROME_DIR overrides. */
export function chromeUserDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (env.POINTER_CHROME_DIR) return env.POINTER_CHROME_DIR;
  if (platform === "darwin") return path.posix.join(home, "Library", "Application Support", "Google", "Chrome");
  if (platform === "win32") {
    return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "Google", "Chrome", "User Data");
  }
  return path.posix.join(home, ".config", "google-chrome");
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM"; // alive, owned by someone else
  }
}

/**
 * Whether Chrome runs on this user data dir: its SingletonLock is a symlink to
 * "<host>-<pid>" while it runs. true / false, or null when it can't be told (Windows).
 */
export function chromeIsRunning(userDataDir, { platform = process.platform, alive = pidAlive } = {}) {
  if (platform === "win32") return null;
  let target;
  try {
    target = fs.readlinkSync(path.join(userDataDir, "SingletonLock"));
  } catch {
    return false; // no lock: Chrome is not running
  }
  const pid = Number(String(target).split("-").pop());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return alive(pid); // a lock left by a crash names a dead pid
}

/**
 * Every profile Chrome knows: folder, the name the human gave it, email, and
 * whether Chrome runs it. Chrome keeps last_active_profiles after a quit (to
 * reopen them), so it counts only while Chrome itself is running.
 */
export function readProfiles(userDataDir, { platform = process.platform } = {}) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(path.join(userDataDir, "Local State"), "utf8"));
  } catch (err) {
    const why = err?.code === "ENOENT" ? "not found" : "could not be read";
    return { profiles: [], error: `Chrome's Local State ${why} in ${userDataDir}, so profile names are missing.` };
  }
  const cache = state?.profile?.info_cache;
  if (!cache || typeof cache !== "object") {
    return { profiles: [], error: `Chrome's Local State in ${userDataDir} lists no profiles, so profile names are missing.` };
  }
  const up = chromeIsRunning(userDataDir, { platform }) !== false;
  const running = new Set(up && Array.isArray(state.profile.last_active_profiles) ? state.profile.last_active_profiles : []);
  const profiles = Object.entries(cache).map(([dir, p]) => ({
    dir,
    name: String(p?.name || dir),
    email: String(p?.user_name || ""),
    running: running.has(dir),
  }));
  return { profiles, error: null };
}

function storeDir(userDataDir, dir, extensionId) {
  return path.join(userDataDir, dir, "Local Extension Settings", extensionId);
}

/** The one profile folder whose Pointer storage holds this instance id, or null (none, or more than one). */
export function profileOfInstance(userDataDir, dirs, extensionIds, instanceId) {
  if (!instanceId) return null;
  const needle = Buffer.from(String(instanceId));
  const found = [];
  for (const dir of dirs) {
    let hit = false;
    for (const ext of extensionIds) {
      const store = storeDir(userDataDir, dir, ext);
      let files;
      try {
        files = fs.readdirSync(store).filter((f) => f.endsWith(".log") || f.endsWith(".ldb"));
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          if (fs.readFileSync(path.join(store, f)).includes(needle)) {
            hit = true;
            break;
          }
        } catch {}
      }
      if (hit) break;
    }
    if (hit) found.push(dir);
  }
  return found.length === 1 ? found[0] : null;
}

/** Whether any of these Pointer builds has ever stored data in this profile. */
export function hasPointer(userDataDir, dir, extensionIds) {
  return extensionIds.some((ext) => {
    try {
      return fs.statSync(storeDir(userDataDir, dir, ext)).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Match what a person typed to one profile: exact name, then exact email,
 * then exact folder, then a prefix of any of them that names only one.
 */
export function matchProfile(query, entries) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return { error: "Name a profile: its name, email, or folder.", candidates: entries };
  const fields = (e) => [e.name, e.email, e.dir].map((v) => String(v || "").toLowerCase());
  for (const i of [0, 1, 2]) {
    const exact = entries.filter((e) => fields(e)[i] === q);
    if (exact.length === 1) return { match: exact[0] };
    if (exact.length > 1) return { error: `"${query}" names more than one profile.`, candidates: exact };
  }
  const prefix = entries.filter((e) => fields(e).some((f) => f && f.startsWith(q)));
  if (prefix.length === 1) return { match: prefix[0] };
  if (prefix.length > 1) return { error: `"${query}" matches more than one profile.`, candidates: prefix };
  return { error: `No profile matches "${query}".`, candidates: entries };
}

/** The command that opens Chrome in one profile. Arguments only: never a shell. */
export function launchCommand(dir, { platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const flag = `--profile-directory=${dir}`;
  if (platform === "darwin") return { command: "open", args: ["-g", "-na", "Google Chrome", "--args", flag] };
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    const exe = roots.map((r) => path.win32.join(r, "Google", "Chrome", "Application", "chrome.exe")).find((p) => exists(p));
    if (!exe) throw new Error("Google Chrome was not found in the usual install folders.");
    return { command: exe, args: [flag] };
  }
  return { command: "google-chrome", args: [flag] };
}

/**
 * Open Chrome in that profile. Resolves once the command has started (or exited
 * cleanly); rejects at once when it cannot run, so the caller can say why
 * instead of waiting for a Pointer that will never connect.
 */
export function launchChrome(dir) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const { command, args } = launchCommand(dir);
      child = spawn(command, args, { shell: false, detached: true, stdio: "ignore" });
    } catch (err) {
      reject(err);
      return;
    }
    const settle = setTimeout(resolve, 1500);
    settle.unref?.();
    child.on("error", (err) => {
      clearTimeout(settle);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(settle);
      if (code) reject(new Error(`the launch command exited with code ${code}`));
      else resolve();
    });
    child.unref();
  });
}
