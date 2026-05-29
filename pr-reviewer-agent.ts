#!/usr/bin/env npx ts-node
/**
 * CoreIT PR Reviewer Agent
 * - Fetches open PRs from the coreit repo
 * - Reviews each unreviewed PR using Claude
 * - Posts review comments via GitHub API
 */

import https from "https";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const REPO = "galshalomhubit/coreit";
const BOT_USER = "galshalomhubit";

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

async function getOpenPRs(): Promise<any[]> {
  const result = await request("GET", "api.github.com", `/repos/${REPO}/pulls?state=open&per_page=10`, undefined, {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    "User-Agent": "coreit-agent",
  });
  return Array.isArray(result) ? result : [];
}

async function getPRDiff(prNumber: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: "GET",
      hostname: "api.github.com",
      path: `/repos/${REPO}/pulls/${prNumber}`,
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "User-Agent": "coreit-agent",
        Accept: "application/vnd.github.v3.diff",
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.end();
  });
}

async function getExistingReviews(prNumber: number): Promise<any[]> {
  const result = await request("GET", "api.github.com", `/repos/${REPO}/pulls/${prNumber}/reviews`, undefined, {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    "User-Agent": "coreit-agent",
  });
  return Array.isArray(result) ? result : [];
}

async function reviewWithClaude(pr: any, diff: string): Promise<string> {
  const truncatedDiff = diff.slice(0, 6000);
  const result = await request("POST", "api.anthropic.com", "/v1/messages", {
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    messages: [{
      role: "user",
      content: `You are reviewing a pull request for CoreIT — a B2B SaaS IT management portal built with React, Express, Prisma, and Supabase.

PR Title: ${pr.title}
PR Description: ${pr.body ?? "No description provided"}

Diff (truncated to 6000 chars):
\`\`\`diff
${truncatedDiff}
\`\`\`

Review this PR focusing on:
1. Security issues (SQL injection, auth bypass, XSS, exposed secrets)
2. Performance (N+1 queries, missing Promise.all, blocking UI)
3. Missing error handling
4. Code quality and correctness

Rules for this codebase:
- All mutations must be optimistic (update local state before API call)
- Never add DB queries to middleware
- All bulk operations must use Promise.all, never sequential await in loops
- Search inputs must use 300ms debounce
- Never leak error details to clients — use safeError()

Format your review as:
**Summary**: 1-2 sentences on the overall change
**Issues** (if any): bullet list of specific problems with line references
**Suggestions**: bullet list of improvements
**Verdict**: APPROVE / REQUEST_CHANGES / COMMENT

Keep it concise and actionable. Be direct, not ceremonial.`,
    }],
  }, {
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  });

  return result.content?.[0]?.text ?? "Unable to generate review.";
}

async function postReview(prNumber: number, review: string, verdict: string) {
  const eventMap: Record<string, string> = {
    "APPROVE": "APPROVE",
    "REQUEST_CHANGES": "REQUEST_CHANGES",
    "COMMENT": "COMMENT",
  };
  const event = eventMap[verdict] ?? "COMMENT";

  await request("POST", "api.github.com", `/repos/${REPO}/pulls/${prNumber}/reviews`, {
    body: review,
    event,
  }, {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    "User-Agent": "coreit-agent",
  });
}

async function main() {
  console.log(`\n🤖 CoreIT PR Reviewer — ${new Date().toISOString()}`);

  const prs = await getOpenPRs();
  console.log(`Found ${prs.length} open PR(s)`);

  for (const pr of prs) {
    const reviews = await getExistingReviews(pr.number);
    const alreadyReviewed = reviews.some((r: any) => r.user?.login === BOT_USER);

    if (alreadyReviewed) {
      console.log(`  — PR #${pr.number}: already reviewed`);
      continue;
    }

    console.log(`  → Reviewing PR #${pr.number}: ${pr.title}`);
    const diff = await getPRDiff(pr.number);
    const review = await reviewWithClaude(pr, diff);

    const verdictMatch = review.match(/\*\*Verdict\*\*:\s*(APPROVE|REQUEST_CHANGES|COMMENT)/i);
    const verdict = verdictMatch?.[1] ?? "COMMENT";

    await postReview(pr.number, review, verdict);
    console.log(`    ✓ Posted review (${verdict})`);
  }

  console.log("Done.\n");
}

main().catch(console.error);
