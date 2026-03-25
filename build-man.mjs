#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

function checkDocker() {
  const result = spawnSync("docker", ["--version"], { stdio: "ignore" });
  if (result.status !== 0) {
    console.error(
      "Error: Docker is not installed. Please install it from https://docker.com/desktop"
    );
    process.exit(1);
  }
}

function runBuild() {
  const cwd = process.cwd();
  const script = `
set -euo pipefail
find /data -type f -regex '.*\\.[0-9]' | while read -r f; do
    dos2unix "$f"
    echo "man2md: converting file $f to \${f}.md"
    pandoc -f man -t markdown "$f" -o "\${f}.md"
done
`;
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${cwd}/man:/data`,
      "ubuntu",
      "bash",
      "-c",
      `
apt-get update -qq &&
apt-get install -y -qq pandoc dos2unix &&
${script}
      `,
    ],
    { stdio: "inherit" }
  );
  process.exit(result.status ?? 0);
}

checkDocker();
runBuild();