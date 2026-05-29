#!/usr/bin/env npx ts-node
/**
 * CoreIT Blog Writer Agent
 * - Picks a fresh SEO topic relevant to IT managers at SMBs
 * - Writes a full blog post using Claude
 * - Publishes to coreit.hashnode.dev via Hashnode API
 */

import https from "https";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const HASHNODE_API_KEY = process.env.HASHNODE_API_KEY!;
const HASHNODE_HOST = "coreit.hashnode.dev";

const TOPICS = [
  "How to audit your SaaS subscriptions in one afternoon",
  "The hidden cost of slow IT onboarding at growing companies",
  "Why employee offboarding is your biggest security risk",
  "5 signs your IT asset tracking is broken (and how to fix it)",
  "License sprawl: how SMBs waste thousands on software nobody uses",
  "The IT manager's checklist for onboarding a new hire in under an hour",
  "How to build an IT asset inventory from scratch",
  "Shadow IT at small companies: what it costs and how to stop it",
  "BYOD policies for SMBs: a practical guide",
  "How to reduce SaaS spend by 30% without cutting tools people love",
];

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

async function getPublicationId(): Promise<string> {
  const query = `{ publication(host: "${HASHNODE_HOST}") { id } }`;
  const result = await request("POST", "gql.hashnode.com", "/", { query }, {
    Authorization: HASHNODE_API_KEY,
  });
  return result?.data?.publication?.id;
}

async function writePost(topic: string): Promise<{ title: string; content: string; subtitle: string; tags: string[] }> {
  const result = await request("POST", "api.anthropic.com", "/v1/messages", {
    model: "claude-sonnet-4-6",
    max_tokens: 3000,
    messages: [{
      role: "user",
      content: `Write an SEO-optimized blog post for CoreIT — a B2B SaaS IT management portal for IT managers at small and midsize companies (10-200 employees).

Topic: "${topic}"

Requirements:
- Tone: practical, peer-to-peer (IT manager talking to another IT manager), no fluff
- Length: 600-900 words
- Structure: intro hook, 3-5 actionable sections with H2 headers, conclusion with soft CTA to try CoreIT free
- Include 1 naturally placed mention of CoreIT as a solution (not pushy)
- SEO: use the topic keywords naturally throughout
- No bullet-point-heavy filler — write in paragraphs

Return a JSON object with these exact keys:
{
  "title": "the post title",
  "subtitle": "one sentence subtitle for SEO meta",
  "tags": ["tag1", "tag2", "tag3"],
  "content": "the full post in markdown"
}

Return ONLY valid JSON, nothing else.`,
    }],
  }, {
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  });

  const text = result.content?.[0]?.text ?? "{}";
  return JSON.parse(text);
}

async function publishPost(publicationId: string, post: { title: string; content: string; subtitle: string; tags: string[] }) {
  const slug = post.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const mutation = `
    mutation PublishPost($input: PublishPostInput!) {
      publishPost(input: $input) {
        post { id url title }
      }
    }
  `;
  const variables = {
    input: {
      title: post.title,
      subtitle: post.subtitle,
      publicationId,
      contentMarkdown: post.content,
      slug,
      tags: post.tags.slice(0, 5).map((name: string) => ({ name, slug: name.toLowerCase().replace(/\s+/g, "-") })),
    },
  };

  return request("POST", "gql.hashnode.com", "/", { query: mutation, variables }, {
    Authorization: HASHNODE_API_KEY,
  });
}

async function getAlreadyPublished(): Promise<Set<string>> {
  const query = `{ publication(host: "${HASHNODE_HOST}") { posts(first: 20) { edges { node { title } } } } }`;
  const result = await request("POST", "gql.hashnode.com", "/", { query }, {
    Authorization: HASHNODE_API_KEY,
  });
  const posts = result?.data?.publication?.posts?.edges ?? [];
  return new Set(posts.map((e: any) => e.node.title));
}

async function main() {
  console.log(`\n🤖 CoreIT Blog Writer — ${new Date().toISOString()}`);

  const publicationId = await getPublicationId();
  if (!publicationId) { console.error("Could not get publication ID"); process.exit(1); }
  console.log(`Publication ID: ${publicationId}`);

  const published = await getAlreadyPublished();
  const available = TOPICS.filter((t) => !published.has(t));

  if (available.length === 0) {
    console.log("All topics already published. Add new topics to the TOPICS array.");
    return;
  }

  // Pick a random unused topic
  const topic = available[Math.floor(Math.random() * available.length)];
  console.log(`Writing post: "${topic}"`);

  const post = await writePost(topic);
  console.log(`  Title: ${post.title}`);

  const result = await publishPost(publicationId, post);
  const url = result?.data?.publishPost?.post?.url;

  if (url) {
    console.log(`  ✓ Published: ${url}`);
  } else {
    console.error("  ✗ Publish failed:", JSON.stringify(result));
  }

  console.log("Done.\n");
}

main().catch(console.error);
