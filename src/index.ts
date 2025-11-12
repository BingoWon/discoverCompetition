import type { KVNamespace } from "@cloudflare/workers-types";

interface Env {
  COMPETITION_KV: KVNamespace;
  TARGET_URL?: string;
  COMPETITION_PAGE_BASE?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

interface Competition {
  id: string;
  title: string;
  description: string;
  prize: string;
  timeLeft: string;
  source: string;
  participants: number;
  tags: string[];
}

interface WorkflowResult {
  fetched: number;
  newItems: number;
  notified: number;
  timestamp: string;
}

const RSC_CHUNK_REGEX = /self\.__next_f\.push\(\[1,"(.*?)"\]\)/gs;
const DEFAULT_TARGET_URL =
  "https://www.competehub.dev/zh/competitions?page=1&sort=recently-launched";
const DEFAULT_COMPETITION_PAGE_BASE = "https://www.competehub.dev/competitions/";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/__health") {
      return new Response("ok", { status: 200 });
    }

    try {
      const result = await runWorkflow(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      console.error("Workflow failed", error);
      return new Response("internal error", { status: 500 });
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runWorkflow(env).then((result) => {
        console.log("Workflow completed:", JSON.stringify(result));
      })
    );
  },
};

async function runWorkflow(env: Env): Promise<WorkflowResult> {
  console.log("=== Workflow started ===");

  const html = await fetchHtml(env);
  console.log(`Fetched HTML with length: ${html.length}`);

  const competitions = extractCompetitions(html);
  console.log(`Total competitions extracted: ${competitions.length}`);

  const newItems = await filterNewCompetitions(env, competitions);
  console.log(`New competitions found: ${newItems.length}`);

  let notified = 0;

  if (newItems.length > 0) {
    console.log(`Storing ${newItems.length} new competitions to KV`);
    await storeSeen(env, newItems);

    try {
      await notifyTelegram(env, newItems);
      notified = newItems.length;
      console.log(`Successfully notified ${notified} competitions via Telegram`);
    } catch (error) {
      console.error("Telegram notification error", error);
    }
  } else {
    console.log("No new competitions to notify");
  }

  const result = {
    fetched: competitions.length,
    newItems: newItems.length,
    notified,
    timestamp: new Date().toISOString(),
  };

  console.log("=== Workflow completed ===");

  return result;
}

async function fetchHtml(env: Env): Promise<string> {
  const url = env.TARGET_URL ?? DEFAULT_TARGET_URL;
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/122.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch competitions (${response.status})`);
  }

  return response.text();
}

function extractCompetitions(html: string): Competition[] {
  const chunk = decodeCompetitionChunk(html);
  if (!chunk) {
    console.error("CRITICAL: No RSC chunk found with card-view- marker");
    return [];
  }

  console.log(`Found RSC chunk with length: ${chunk.length}`);

  const competitions: Competition[] = [];

  let searchIndex = 0;
  const marker = '\\"card-view-';
  let iteration = 0;

  while (true) {
    iteration++;
    const markerIndex = chunk.indexOf(marker, searchIndex);
    if (markerIndex === -1) {
      break;
    }

    const objectStart = chunk.indexOf("{", markerIndex);
    if (objectStart === -1) {
      console.error(`Iteration ${iteration}: No opening brace found after marker at index ${markerIndex}`);
      break;
    }

    const raw = extractJsonBlock(chunk, objectStart);
    if (!raw) {
      console.error(`Iteration ${iteration}: extractJsonBlock returned null at marker index ${markerIndex}, object start ${objectStart}`);
      // Continue to next competition instead of breaking
      searchIndex = objectStart + 1;
      continue;
    }

    try {
      const json = parseCompetitionJson(raw);
      const comp = json?.competition;
      if (!comp || !comp.id || !comp.title) {
        console.warn(`Iteration ${iteration}: Invalid competition data (missing id or title)`);
        searchIndex = objectStart + raw.length;
        continue;
      }

      const description = normalizeSpaces(comp.description ?? "");

      competitions.push({
        id: String(comp.id),
        title: String(comp.title),
        description,
        prize: String(comp.prize ?? ""),
        timeLeft: String(comp.timeLeft ?? ""),
        source: String(comp.source ?? ""),
        participants: Number(comp.participants ?? 0),
        tags: Array.isArray(comp.tags) ? comp.tags.map((tag: unknown) => String(tag)) : [],
      });
    } catch (error) {
      console.error(`Iteration ${iteration}: Failed to parse competition payload`, error);
    }

    searchIndex = objectStart + raw.length;
  }

  console.log(`Extracted ${competitions.length} competitions from ${iteration} iterations`);

  if (competitions.length === 0) {
    console.error("CRITICAL: No competitions extracted despite finding RSC chunk");
  }

  return competitions;
}

function decodeCompetitionChunk(html: string): string | null {
  const regex = new RegExp(RSC_CHUNK_REGEX);
  for (const match of html.matchAll(regex)) {
    const raw = match[1];
    const decoded = decodeEscapedString(raw);
    if (decoded && decoded.includes("card-view-")) {
      return decoded;
    }
  }
  return null;
}

function decodeEscapedString(input: string): string | null {
  const escaped = input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    const firstPass = JSON.parse(`"${escaped}"`);
    return unescapeUnicode(firstPass);
  } catch (error) {
    console.warn("Failed to decode escaped string", error);
    return null;
  }
}

function unescapeUnicode(input: string): string {
  return input.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) =>
    String.fromCharCode(parseInt(code, 16)),
  );
}

function parseCompetitionJson(raw: string): any {
  try {
    const normalized = raw.replace(/\\"/g, '"');
    return JSON.parse(normalized);
  } catch (error) {
    const buf = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      buf[i] = raw.charCodeAt(i);
    }
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const normalized = decoded.replace(/\\"/g, '"');
    return JSON.parse(normalized);
  }
}

function extractJsonBlock(source: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;

  for (let i = startIndex; i < source.length; i++) {
    const char = source[i];
    const prev = source[i - 1];

    if (char === '"' && prev !== "\\") {
      inString = !inString;
    }

    if (!inString) {
      if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0) {
          return source.slice(startIndex, i + 1);
        }
      }
    }
  }

  return null;
}

async function filterNewCompetitions(env: Env, competitions: Competition[]): Promise<Competition[]> {
  if (!env.COMPETITION_KV) {
    console.warn("KV binding missing; treating all competitions as new");
    return competitions;
  }

  const checks = competitions.map((comp) =>
    env.COMPETITION_KV.get(`seen:${comp.id}`, { type: "text" }),
  );
  const existing = await Promise.all(checks);

  const fresh: Competition[] = [];
  existing.forEach((value, index) => {
    if (value === null) {
      fresh.push(competitions[index]);
    }
  });

  return fresh;
}

async function storeSeen(env: Env, competitions: Competition[]): Promise<void> {
  if (!env.COMPETITION_KV) {
    return;
  }

  const ops = competitions.map((comp) =>
    env.COMPETITION_KV.put(
      `seen:${comp.id}`,
      JSON.stringify({ id: comp.id, storedAt: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 90 },
    ),
  );
  await Promise.all(ops);
}

async function notifyTelegram(env: Env, competitions: Competition[]): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.info("Telegram credentials missing; skipping notification");
    return;
  }

  const baseUrl = env.COMPETITION_PAGE_BASE ?? DEFAULT_COMPETITION_PAGE_BASE;
  const lines = competitions.map((comp) => formatCompetition(comp, baseUrl));
  const message = `发现 ${competitions.length} 个新竞赛：\n\n${lines.join("\n\n")}`;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const params = new URLSearchParams({
    chat_id: chatId,
    text: message,
    parse_mode: "MarkdownV2",
    disable_web_page_preview: "true",
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
  });

  if (!response.ok) {
    const body = await response.text();
    console.error("Telegram notification failed", response.status, body);
    throw new Error(`Failed to send Telegram notification (${response.status})`);
  }
}

function formatCompetition(comp: Competition, baseUrl: string): string {
  const link = escapeMarkdown(`${baseUrl}${comp.id}`);
  const title = escapeMarkdown(comp.title);
  const prize = escapeMarkdown(comp.prize || "未知");
  const timeLeft = escapeMarkdown(comp.timeLeft || "未知");
  const description = comp.description ? escapeMarkdown(trimDescription(comp.description)) : "-";
  const tags =
    comp.tags.length > 0 ? comp.tags.map((tag) => `\`${escapeMarkdown(tag)}\``).join(" ") : "-";

  return [
    `• [${title}](${link})`,
    `  来源: ${escapeMarkdown(comp.source || "未知")}`,
    `  奖金: ${prize}`,
    `  截止: ${timeLeft}`,
    `  标签: ${tags}`,
    `  简介: ${description}`,
  ].join("\n");
}

function escapeMarkdown(input: string): string {
  return input.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function trimDescription(description: string): string {
  if (description.length <= 160) {
    return description;
  }
  return `${description.slice(0, 157)}...`;
}

function normalizeSpaces(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}
