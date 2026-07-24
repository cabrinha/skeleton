import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { exec } from 'child_process';
import * as readline from 'readline';
import { PNG } from 'pngjs';
import { BASE_URL, COOKIE_FILE, VAMPIRE_COOKIE_PQ, VAMPIRE_COOKIE_IP } from './config.js';

export class Session {
  private readonly jar: CookieJar;
  private readonly client: ReturnType<typeof wrapper>;

  constructor() {
    this.jar = new CookieJar();
    // Spoof a real Safari browser UA so requests blend in with normal web traffic.
    const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15';
    const instance = axios.create({ headers: { 'User-Agent': userAgent }, maxRedirects: 5, timeout: 30_000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (instance.defaults as any).jar = this.jar;
    this.client = wrapper(instance);
  }

  async get(params: Record<string, string> = {}): Promise<string> {
    const resp = await this.withRetry(
      () => this.client.get<string>(BASE_URL, { params, responseType: 'text' }),
      `GET ${new URLSearchParams(params).toString() || '(page)'}`,
    );
    return resp.data;
  }

  async post(fields: Record<string, string>): Promise<string> {
    const body = new URLSearchParams(fields).toString();
    const resp = await this.withRetry(
      () => this.client.post<string>(BASE_URL, body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        responseType: 'text',
      }),
      `POST ${fields.action ?? '(form)'}`,
    );
    return resp.data;
  }

  // Retry transient network failures (timeouts, connection resets, DNS blips,
  // 5xx) with exponential backoff. A single flaky request to quiz.ravenblack.net
  // must not crash a whole hunt — previously an unhandled ETIMEDOUT propagated to
  // main() and exit(1)'d the process mid-hunt, stranding the remaining AP.
  private async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    const maxAttempts = 4;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt === maxAttempts || !isTransientError(err)) throw err;
        const backoffMs = Math.min(15_000, 1_000 * 2 ** (attempt - 1)); // 1s, 2s, 4s
        console.warn(`[net] ${label} failed (attempt ${attempt}/${maxAttempts}): ${describeError(err)} — retrying in ${backoffMs}ms`);
        await sleep(backoffMs);
      }
    }
    throw lastErr;
  }

  saveCookies(): void {
    const cookies = this.jar.getCookiesSync('https://quiz.ravenblack.net');
    const data = cookies.map(c => ({ key: c.key, value: c.value }));
    writeFileSync(COOKIE_FILE, JSON.stringify(data, null, 2));
  }

  loadCookies(): boolean {
    if (!existsSync(COOKIE_FILE)) return false;
    try {
      const data = JSON.parse(readFileSync(COOKIE_FILE, 'utf-8')) as Array<{ key: string; value: string }>;
      for (const { key, value } of data) {
        this.jar.setCookieSync(`${key}=${value}`, 'https://quiz.ravenblack.net');
      }
      return data.length > 0;
    } catch {
      return false;
    }
  }

  injectEnvCookies(): boolean {
    if (!VAMPIRE_COOKIE_PQ || !VAMPIRE_COOKIE_IP) return false;
    this.jar.setCookieSync(`pq=${VAMPIRE_COOKIE_PQ}`, 'https://quiz.ravenblack.net');
    this.jar.setCookieSync(`ip=${VAMPIRE_COOKIE_IP}`, 'https://quiz.ravenblack.net');
    return true;
  }

  /**
   * Solve the anti-bot challenge and clear the gate cookie.
   * Does NOT retry the original request — callers must do that.
   */
  async solveAntibot(html: string): Promise<void> {
    const m = html.match(/anti_robot\(Array\(([^)]+)\)\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/);
    if (!m) return;
    const rawColors = [...m[1].matchAll(/"([0-9a-f]{6})"/g)].map(x => x[1]);
    const pixelStr  = m[2];
    const fieldName = m[3];

    const imgPath = this.renderAntibotImage(rawColors, pixelStr);
    console.log(`[anti-bot] Image: ${imgPath}`);
    exec(`open "${imgPath}" 2>/dev/null || xdg-open "${imgPath}" 2>/dev/null`);

    const answer = await this.promptUser('[anti-bot] Enter the number shown in the image: ');
    await this.post({ action: 'robot', [fieldName]: answer });
    // Gate is now cleared; caller retries the original request
  }

  private renderAntibotImage(colors: string[], pixelStr: string): string {
    const COLS = 96, CELL_W = 2, CELL_H = 4;
    const rows = Math.floor(pixelStr.length / COLS);
    const png = new PNG({ width: COLS * CELL_W, height: rows * CELL_H });

    for (let i = 0; i < pixelStr.length; i++) {
      const colorIdx = pixelStr.charCodeAt(i) - 97; // 'a' = 0
      const hex = colors[colorIdx] ?? '000000';
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const col = i % COLS, row = Math.floor(i / COLS);
      for (let dy = 0; dy < CELL_H; dy++) {
        for (let dx = 0; dx < CELL_W; dx++) {
          const idx = ((row * CELL_H + dy) * COLS * CELL_W + (col * CELL_W + dx)) * 4;
          png.data[idx] = r; png.data[idx + 1] = g;
          png.data[idx + 2] = b; png.data[idx + 3] = 255;
        }
      }
    }

    const path = join(tmpdir(), `antibot-${Date.now()}.png`);
    writeFileSync(path, PNG.sync.write(png));
    return path;
  }

  private promptUser(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
      rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
    });
  }
}

const TRANSIENT_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED',
  'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ERR_NETWORK',
]);

// True for retryable failures. Walks the error chain (axios wraps causes, and
// Node's happy-eyeballs raises an AggregateError with per-attempt .errors) so a
// nested ETIMEDOUT is still recognised. 5xx responses are retried too.
function isTransientError(err: unknown): boolean {
  const codes: string[] = [];
  const statuses: number[] = [];
  const visit = (e: unknown, depth: number): void => {
    if (!e || typeof e !== 'object' || depth > 4) return;
    const o = e as { code?: unknown; response?: { status?: number }; errors?: unknown[]; cause?: unknown };
    if (typeof o.code === 'string') codes.push(o.code);
    if (typeof o.response?.status === 'number') statuses.push(o.response.status);
    if (Array.isArray(o.errors)) o.errors.forEach(x => visit(x, depth + 1));
    if (o.cause) visit(o.cause, depth + 1);
  };
  visit(err, 0);
  return statuses.some(s => s >= 500) || codes.some(c => TRANSIENT_CODES.has(c));
}

function describeError(err: unknown): string {
  const o = err as { code?: string; response?: { status?: number }; message?: string };
  return o?.code ?? (o?.response?.status ? `HTTP ${o.response.status}` : o?.message ?? 'unknown');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
