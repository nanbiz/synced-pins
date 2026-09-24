import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const STARTUP_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 20_000;

export function findBrowserExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, 'chromium');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this PATH entry.
    }
  }
  return null;
}

// Chromium derives an unpacked extension's id from the SHA-256 of its resolved
// path, written with the letters a to p for the hex digits.
export function extensionIdForPath(path) {
  const hex = createHash('sha256').update(realpathSync(path)).digest('hex').slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('');
}

// A throwaway directory holding the browser profile plus the HOME and
// XDG_RUNTIME_DIR the browser runs with, so it never reaches the user's
// session sockets or dotfiles.
export async function createSandbox() {
  const root = await mkdtemp(join(tmpdir(), 'synced-pins-e2e-'));
  const sandbox = {
    root,
    profile: join(root, 'profile'),
    home: join(root, 'home'),
    runtime: join(root, 'runtime'),
    remove: () => rm(root, { recursive: true, force: true }),
  };
  await mkdir(sandbox.home);
  await mkdir(sandbox.runtime, { mode: 0o700 });
  return sandbox;
}

function browserEnv(sandbox) {
  const env = {
    ...process.env,
    HOME: sandbox.home,
    XDG_CONFIG_HOME: join(sandbox.home, '.config'),
    XDG_CACHE_HOME: join(sandbox.home, '.cache'),
    XDG_RUNTIME_DIR: sandbox.runtime,
    DBUS_SESSION_BUS_ADDRESS: 'disabled:',
    GDK_BACKEND: 'x11',
  };
  delete env.WAYLAND_DISPLAY;
  return env;
}

// The browser runs headed, on the Xvfb display scripts/test-e2e.sh starts;
// that script marks the environment so no other display is ever used.
export async function launchBrowser({ executable, sandbox, extensionPath }) {
  if (!process.env.SYNCED_PINS_XVFB || !process.env.DISPLAY) {
    throw new Error('run the suite through scripts/test-e2e.sh, which gives the browser its own Xvfb display');
  }
  const child = spawn(executable, [
    `--user-data-dir=${sandbox.profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--password-store=basic',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--ozone-platform=x11',
    'about:blank',
  ], { env: browserEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const url = await devToolsUrl(child);
  const connection = await Connection.open(url);
  return new Browser(child, exited, connection, extensionIdForPath(extensionPath));
}

function devToolsUrl(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => fail('no DevTools endpoint within the startup timeout'), STARTUP_TIMEOUT_MS);
    function fail(reason) {
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new Error(`${reason}\n${output.slice(-4000)}`));
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('exit', (code, signal) => fail(`browser exited early (code ${code}, signal ${signal})`));
  });
}

class Connection {
  #socket;
  #nextId = 1;
  #calls = new Map();
  #listeners = new Set();

  static open(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.onopen = () => resolve(new Connection(socket));
      socket.onerror = () => reject(new Error(`cannot connect to ${url}`));
    });
  }

  constructor(socket) {
    this.#socket = socket;
    socket.onmessage = (message) => this.#receive(JSON.parse(message.data));
    socket.onclose = () => {
      for (const call of this.#calls.values()) call.reject(new Error(`connection closed during ${call.method}`));
      this.#calls.clear();
    };
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#calls.delete(id);
        reject(new Error(`${method} got no answer within ${CALL_TIMEOUT_MS} ms`));
      }, CALL_TIMEOUT_MS);
      const settle = (settler) => (value) => {
        clearTimeout(timer);
        settler(value);
      };
      this.#calls.set(id, { resolve: settle(resolve), reject: settle(reject), method });
    });
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close() {
    this.#socket.close();
  }

  #receive(message) {
    if (message.id === undefined) {
      for (const listener of this.#listeners) listener(message);
      return;
    }
    const call = this.#calls.get(message.id);
    if (!call) return;
    this.#calls.delete(message.id);
    if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}`));
    else call.resolve(message.result);
  }
}

// A JavaScript context inside the browser (the extension service worker or a
// page) that runs functions serialised from the test process.
class Context {
  constructor(connection, sessionId) {
    this.connection = connection;
    this.sessionId = sessionId;
  }

  // Sends a key press through the browser's input pipeline, so browser
  // shortcuts such as Ctrl+1 act as they do for the user.
  async press(key, { ctrl = false } = {}) {
    const code = /^[0-9]$/.test(key) ? `Digit${key}` : key;
    const keyCode = key === 'Enter' ? 13 : key.charCodeAt(0);
    const text = key === 'Enter' ? '\r' : undefined;
    for (const type of [text ? 'keyDown' : 'rawKeyDown', 'keyUp']) {
      await this.connection.send('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        modifiers: ctrl ? 2 : 0,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        text: type === 'keyUp' ? undefined : text,
      }, this.sessionId);
    }
  }

  async run(fn, ...args) {
    const { result, exceptionDetails } = await this.connection.send('Runtime.evaluate', {
      expression: `(${fn})(...${JSON.stringify(args)})`,
      awaitPromise: true,
      returnByValue: true,
    }, this.sessionId);
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }
}

class Browser {
  #child;
  #exited;

  constructor(child, exited, connection, extensionId) {
    this.#child = child;
    this.#exited = exited;
    this.connection = connection;
    this.extensionOrigin = `chrome-extension://${extensionId}`;
  }

  async targets() {
    const { targetInfos } = await this.connection.send('Target.getTargets');
    return targetInfos;
  }

  async attach(targetId) {
    const { sessionId } = await this.connection.send('Target.attachToTarget', { targetId, flatten: true });
    return new Context(this.connection, sessionId);
  }

  // The worker target shows up before its script has run, so the context is
  // only handed out once the extension APIs exist in it.
  async extensionWorker() {
    const target = await waitFor(async () => (await this.targets()).find(
      (info) => info.type === 'service_worker' && info.url.startsWith(`${this.extensionOrigin}/`),
    ));
    const worker = await this.attach(target.targetId);
    await waitFor(() => worker.run(() => globalThis.chrome?.tabs !== undefined));
    return worker;
  }

  // The page with this URL, or the first page whose URL passes the test.
  async page(url) {
    const matches = typeof url === 'function' ? url : (candidate) => candidate === url;
    const target = await waitFor(async () => (await this.targets()).find(
      (info) => info.type === 'page' && matches(info.url),
    ));
    return this.attach(target.targetId);
  }

  // Quits the way the user quitting from the menu does: every window closes
  // and the profile is written for the next start.
  async quit() {
    // The browser may drop the connection before it answers.
    await this.connection.send('Browser.close').catch(() => {});
    this.connection.close();
    await this.#exited;
    await this.#processesGone();
  }

  async kill() {
    this.connection.close();
    this.#signalProcesses('SIGKILL');
    await this.#processesGone();
  }

  // The browser runs in its own process group, which also holds whatever a
  // wrapper such as a bubblewrap sandbox starts and leaves running past the
  // wrapper's own exit.
  #signalProcesses(signal) {
    try {
      process.kill(-this.#child.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  #processesGone() {
    return waitFor(() => !this.#signalProcesses(0));
  }
}

export async function waitFor(probe, { timeout = 10_000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeout} ms: ${probe}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
