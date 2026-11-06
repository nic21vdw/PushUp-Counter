import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(import.meta.url);

export function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

export const flag = (name) => process.argv.includes(`--${name}`);

export async function startServer(port) {
  if (port === 4747) throw new Error("4747 is the live counter");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushup-perf-"));
  await fs.copyFile(path.join(ROOT, "server.js"), path.join(dir, "server.js"));
  await fs.symlink(path.join(ROOT, "public"), path.join(dir, "public"), "dir");
  const child = spawn(process.execPath, ["server.js"], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      EXACT_SUBS_URL: "off",
      YOUTUBE_API_KEY: "",
      YOUTUBE_CHANNEL_ID: "",
      YOUTUBE_HANDLE: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("server did not start")),
      15000,
    );
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("OBS source")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", reject);
  });
  return {
    base: `http://127.0.0.1:${port}`,
    stop: async () => {
      child.kill();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

export async function launch({ video = "", cameraFps = 30 } = {}) {
  const { chromium } = require("playwright");
  return chromium.launch({
    args: [
      `--use-fake-device-for-media-stream=fps=${cameraFps}`,
      ...(video ? [`--use-file-for-fake-video-capture=${video}`] : []),
      "--use-fake-ui-for-media-stream",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
}

export const SEEDED_RANDOM = () => {
  let seed = 12345;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const spoof = (Proto) => {
    if (!Proto) return;
    const real = Proto.prototype.getParameter;
    Proto.prototype.getParameter = function (p) {
      if (p === 0x9246) return "ANGLE (Perf Harness GPU)";
      return real.call(this, p);
    };
  };
  spoof(globalThis.WebGLRenderingContext);
  spoof(globalThis.WebGL2RenderingContext);
};

export async function routeAssets(
  context,
  base,
  { threeDir = "", patches = [], cpuDelegate = false } = {},
) {
  if (threeDir) {
    await context.route(
      "https://cdn.jsdelivr.net/npm/three@0.170.0/**",
      async (route) => {
        const rel = new URL(route.request().url()).pathname.replace(
          "/npm/three@0.170.0/",
          "",
        );
        try {
          const body = await fs.readFile(path.join(threeDir, rel));
          await route.fulfill({
            body,
            contentType: rel.endsWith(".json")
              ? "application/json"
              : "text/javascript",
            headers: { "access-control-allow-origin": "*" },
          });
        } catch {
          await route.abort();
        }
      },
    );
  }
  const all = [
    {
      file: "/js/pose-tracker.js",
      find: "this.landmarker = null;",
      replace: "this.landmarker = null; globalThis.__poseTracker = this;",
    },
    ...(cpuDelegate
      ? [
          {
            file: "/js/pose-tracker.js",
            find: 'delegate: "GPU"',
            replace: 'delegate: "CPU"',
          },
        ]
      : []),
    ...patches,
  ];
  for (const file of new Set(all.map((p) => p.file))) {
    await context.route(`${base}${file}`, async (route) => {
      const res = await route.fetch();
      let body = await res.text();
      for (const p of all.filter((x) => x.file === file)) {
        if (p.bodyFrom) {
          body = await fs.readFile(p.bodyFrom, "utf8");
          continue;
        }
        if (!body.includes(p.find))
          throw new Error(`patch not found in ${file}: ${p.find}`);
        body = body.split(p.find).join(p.replace);
      }
      await route.fulfill({ response: res, body });
    });
  }
}

export async function processCpu(browserSession) {
  const { processInfo } = await browserSession.send(
    "SystemInfo.getProcessInfo",
  );
  const out = {};
  for (const p of processInfo) {
    const type = p.type.toLowerCase();
    out[type] = (out[type] ?? 0) + p.cpuTime;
  }
  return { byType: out, processes: processInfo };
}

export async function rss(pid) {
  try {
    const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
    return Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024;
  } catch {
    return null;
  }
}

export function slope(points) {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((s, p) => s + p[0], 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  return den ? num / den : 0;
}
