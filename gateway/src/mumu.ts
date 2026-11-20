// MuMu 模拟器开机后在固定端口上提供 adb，但不会自己连到本机的 adb server：网关替它 adb connect，开机就能出现在侧栏的「MuMu 模拟器」分组里
import { connect as netConnect } from "node:net";

/** MuMu 的 adb 端口：第一个实例是 16384（2026-11-20 本机 MuMuPlayer 实测）。 */
export const MUMU_ADB_PORTS = [16384];
/** 这个 adb 设备 id 是不是 MuMu 的地址（127.0.0.1:<MuMu 端口>）。 */
export function isMumuAddr(id: string): boolean {
  return MUMU_ADB_PORTS.some((port) => id === `127.0.0.1:${port}`);
}

/** 多久看一次端口（我定的数值：开机后几秒内出现在侧栏，空转只是一次本机 TCP 探测）。 */
const INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 300;

/** 本机这个端口有没有在监听。 */
export function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

export function createMumuConnector(deps: {
  probe: (port: number) => Promise<boolean>;
  /** adb connect <addr> 的输出；adb 连不上时也是正常返回，输出里写着 failed。 */
  connect: (addr: string) => Promise<string>;
  /** adb 里已经在线的设备 id。 */
  connected: () => string[];
  log: (s: string) => void;
}) {
  // 每个地址上次记过的结果：同样的结果不重复记，免得 MuMu 没响应时每 5 秒刷一行
  const last = new Map<string, string>();
  const note = (addr: string, s: string) => {
    if (last.get(addr) === s) return;
    last.set(addr, s);
    deps.log(s);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;

  async function tick(): Promise<void> {
    for (const port of MUMU_ADB_PORTS) {
      const addr = `127.0.0.1:${port}`;
      if (deps.connected().includes(addr) || !(await deps.probe(port))) continue;
      const out = await deps.connect(addr).catch((e: Error) => `failed: ${e.message}`);
      note(addr, /connected to/.test(out) ? `已连上 MuMu 模拟器（${addr}）` : `连不上 MuMu 模拟器（${addr}）：${out.trim()}`);
    }
  }

  return {
    tick,
    start() {
      if (!stopped) return;
      stopped = false;
      const loop = () => {
        if (!stopped) timer = setTimeout(() => void tick().finally(loop), INTERVAL_MS);
      };
      void tick().finally(loop);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
