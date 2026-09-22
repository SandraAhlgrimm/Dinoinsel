import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { zipSync } from "fflate";

const root = process.cwd();
const stage = ".package/stage";
await mkdir(".local/tmp", { recursive: true });
await mkdir(".package", { recursive: true });
await rm(stage, { recursive: true, force: true });
await mkdir(stage);

try {
  for (const path of ["dist", "host.json", "package.json", "package-lock.json"]) {
    await cp(path, join(stage, path), { recursive: true });
  }
  const install = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", [
    "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund",
  ], {
    cwd: resolve(stage),
    env: { ...process.env, TMPDIR: resolve(".local/tmp"), npm_config_cache: resolve(".npm-cache") },
    stdio: "inherit",
  });
  if (install.error || install.status !== 0) throw new Error("Production dependency installation failed.");
  const files = {};
  async function addFiles(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".bin") continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await addFiles(path, name);
      else if (entry.isFile()) files[name] = new Uint8Array(await readFile(path));
      else throw new Error("Unexpected non-regular file in deployment staging.");
    }
  }
  await addFiles(stage);
  for (const name of Object.keys(files)) {
    if (/^(?:local\.settings|\.env|test\/|tools\/|infra\/|\.local\/)/.test(name)) {
      throw new Error("A development-only file reached the deployment package.");
    }
  }
  await writeFile(".package/dinoinsel-api.zip", zipSync(files, { level: 6, mtime: new Date("2020-01-01T00:00:00Z") }));
  console.log("Created .package/dinoinsel-api.zip (runtime files and production dependencies only). Nothing was deployed.");
} finally {
  await rm(join(root, stage), { recursive: true, force: true });
}
