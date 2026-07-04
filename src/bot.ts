import { Session } from './session.js';
import { parsePage, parsePints, type PageState, type DrinkTarget } from './parser.js';
import { VAMPIRE_NAME, VAMPIRE_PASS } from './config.js';

export class Bot {
  private lastState: PageState | null = null;

  constructor(
    readonly name: string,
    private readonly password: string,
    private readonly session: Session,
  ) {}

  async fetchPage(params: Record<string, string> = {}): Promise<PageState> {
    let html = await this.session.get(params);
    if (html.includes('anti_robot')) {
      await this.session.solveAntibot(html);
      html = await this.session.get(params); // retry after gate is cleared
    }
    const state = parsePage(html, this.name);
    this.lastState = state;
    return state;
  }

  private async postAction(fields: Record<string, string>): Promise<PageState> {
    let html = await this.session.post(fields);
    if (html.includes('anti_robot')) {
      await this.session.solveAntibot(html);
      html = await this.session.post(fields); // retry after gate is cleared
    }
    const state = parsePage(html, this.name);
    this.lastState = state;
    return state;
  }

  async login(): Promise<boolean> {
    // 1. Env-injected cookies (Docker / K8s)
    if (this.session.injectEnvCookies()) {
      const state = await this.fetchPage();
      if (state.loggedIn) { console.log(`[+] Session active as ${this.name} (env cookies)`); return true; }
    }

    // 2. Saved cookie file
    if (this.session.loadCookies()) {
      const state = await this.fetchPage();
      if (state.loggedIn) { console.log(`[+] Session active as ${this.name} (cookie file)`); return true; }
    }

    // 3. Username / password
    await this.postAction({ action: 'login', iam: this.name, passwd: this.password });
    const state = await this.fetchPage();
    if (state.loggedIn) {
      this.session.saveCookies();
      console.log(`[+] Logged in as ${this.name}`);
      return true;
    }

    console.error('[-] Login failed');
    return false;
  }

  async move(x: number, y: number): Promise<PageState> {
    return this.postAction({ action: 'move', x: String(x), y: String(y) });
  }

  async drink(target: DrinkTarget, zToken: string | null): Promise<{ state: PageState; pints: number }> {
    let html: string;
    if (target.method === 'get') {
      const params: Record<string, string> = { action: 'drink', ...target.params };
      if (zToken) params['z'] = zToken;
      html = await this.session.get(params);
    } else {
      html = await this.session.post(target.params);
    }
    if (html.includes('anti_robot')) {
      await this.session.solveAntibot(html);
      html = target.method === 'get'
        ? await this.session.get({ action: 'drink', ...target.params, ...(zToken ? { z: zToken } : {}) })
        : await this.session.post(target.params);
    }
    const state = parsePage(html, this.name);
    this.lastState = state;
    return { state, pints: parsePints(html) };
  }

  async fight(targetName: string, zToken: string | null): Promise<PageState> {
    const fields: Record<string, string> = { action: 'fight', target: targetName };
    if (zToken) fields['z'] = zToken;
    return this.postAction(fields);
  }

  get state(): PageState | null { return this.lastState; }
}

export function createBot(session: Session): Bot {
  return new Bot(VAMPIRE_NAME, VAMPIRE_PASS, session);
}
