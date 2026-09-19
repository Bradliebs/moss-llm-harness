const { spawnSync } = require("node:child_process");

if (!process.env.MOSS_EVAL_SANDBOX_IMAGE) {
  console.error("MOSS_EVAL_SANDBOX_IMAGE must name a digest-pinned Linux image containing Node.js");
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, [require.resolve("vitest/vitest.mjs"), "run", "electron/backend/moss/evals/sandbox-live.test.ts"], {
    stdio: "inherit", env: { ...process.env, MOSS_EVAL_SANDBOX_LIVE: "1" },
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}