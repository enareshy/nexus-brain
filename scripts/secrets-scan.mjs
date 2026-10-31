// Lightweight secret scanner for staged/tracked files. Use gitleaks in CI when available.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI key", /sk-(proj-)?[A-Za-z0-9]{32,}/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{36,}/],
  ["Slack token", /xox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["Private key", /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];

function listFiles() {
  try {
    return execSync("git ls-files --cached --others --exclude-standard", { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    console.error("secrets-scan: not a git repository; run `git init` first.");
    process.exit(2);
  }
}

const findings = [];
for (const file of listFiles()) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const [label, re] of PATTERNS) {
    if (re.test(text)) findings.push(`${file}: possible ${label}`);
  }
}

if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exit(1);
}
console.log("secrets-scan: no secrets found");
