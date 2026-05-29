#!/usr/bin/env npx ts-node
/**
 * CoreIT Test Writer Agent
 * - Scans backend routes for functions with no test coverage
 * - Uses Claude API to generate test files
 * - Commits new tests to the coreit repo via GitHub API
 */

import https from "https";
import fs from "fs";
import path from "path";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const REPO = "galshalomhubit/coreit";

function request(method: string, hostname: string, urlPath: string, body?: any, headers: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = https.request({
      method, hostname, path: urlPath,
      headers: { "Content-Type": "application/json", ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getRepoFiles(dir: string): Promise<any[]> {
  const result = await request("GET", "api.github.com", `/repos/${REPO}/contents/${dir}`, undefined, {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    "User-Agent": "coreit-agent",
  });
  return Array.isArray(result) ? result : [];
}

async function getFileContent(filePath: string): Promise<string> {
  const result = await request("GET", "api.github.com", `/repos/${REPO}/contents/${filePath}`, undefined, {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    "User-Agent": "coreit-agent",
  });
  return Buffer.from(result.content, "base64").toString("utf-8");
}

async function commitFile(filePath: string, content: string, message: string) {
  // Check if file exists first
  let sha: string | undefined;
  try {
    const existing = await request("GET", "api.github.com", `/repos/${REPO}/contents/${filePath}`, undefined, {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "User-Agent": "coreit-agent",
    });
    sha = existing.sha;
  } catch {}

  await request("PUT", "api.github.com", `/repos/${REPO}/contents/${filePath}`, {
    message,
    content: Buffer.from(content).toString("base64"),
    ...(sha ? { sha } : {}),
  }, {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    "User-Agent": "coreit-agent",
  });
}

async function generateTest(routeFile: string, routeContent: string): Promise<string> {
  const result = await request("POST", "api.anthropic.com", "/v1/messages", {
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    messages: [{
      role: "user",
      content: `You are writing Jest + Supertest integration tests for a CoreIT Express backend route.

Route file: ${routeFile}
Route content:
\`\`\`typescript
${routeContent}
\`\`\`

Write a complete test file that:
- Uses Jest and Supertest
- Tests the happy path for each endpoint
- Tests auth (missing token should return 401)
- Tests validation (bad input should return 400)
- Uses realistic test data
- Mocks Prisma using jest.mock('../lib/prisma')
- Exports nothing — just the test suite

Return ONLY the TypeScript test file content, no explanation.`,
    }],
  }, {
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  });

  return result.content?.[0]?.text ?? "";
}

async function main() {
  console.log(`\n🤖 CoreIT Test Writer — ${new Date().toISOString()}`);

  const routeFiles = await getRepoFiles("backend/src/routes");
  console.log(`Found ${routeFiles.length} route files`);

  const testFiles = await getRepoFiles("backend/src/routes/__tests__");
  const testedRoutes = new Set(testFiles.map((f: any) => f.name.replace(".test.ts", ".ts")));

  let written = 0;
  for (const file of routeFiles) {
    if (!file.name.endsWith(".ts")) continue;
    if (testedRoutes.has(file.name)) {
      console.log(`  — ${file.name}: already has tests`);
      continue;
    }

    console.log(`  → Writing tests for ${file.name}...`);
    const content = await getFileContent(file.path);
    const testContent = await generateTest(file.name, content);

    if (!testContent) continue;

    const testPath = `backend/src/routes/__tests__/${file.name.replace(".ts", ".test.ts")}`;
    await commitFile(testPath, testContent, `test: auto-generate tests for ${file.name}`);
    console.log(`    ✓ Committed ${testPath}`);
    written++;

    // Rate limit: 1 file per run to keep costs low
    if (written >= 1) {
      console.log("  (Rate limited to 1 new test file per run)");
      break;
    }
  }

  console.log(`\nDone. ${written} test file(s) written.\n`);
}

main().catch(console.error);
