import WebSocket from 'ws';

export class DiscordConnectionError extends Error {}

export interface DiscordUserGatewayHandlers {
  onDispatch: (packet: any) => void;
  onReady: () => void;
  onReconnect: () => void;
  onError: (error: Error) => void;
}

export interface DiscordUserGatewayConnection {
  rest: { get: (route: string) => Promise<any> };
  connect: () => Promise<void>;
  close: () => Promise<void>;
}

type SocketLike = WebSocket & { terminate?: () => void };

export class DiscordUserGateway implements DiscordUserGatewayConnection {
  readonly rest: { get: (route: string) => Promise<any> };
  private socket: SocketLike | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = true;
  private ready = false;
  private heartbeatAck = true;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private reconnectAttempts = 0;
  private initialResolve: (() => void) | null = null;
  private initialReject: ((error: Error) => void) | null = null;

  constructor(private readonly options: {
    token: string;
    handlers: DiscordUserGatewayHandlers;
    socketFactory?: () => SocketLike;
    gatewayUrl?: string;
    apiBase?: string;
    connectTimeoutMs?: number;
    reconnectDelayMs?: number;
  }) {
    this.rest = {
      get: async (route: string) => {
        const response = await fetch(`${options.apiBase || 'https://discord.com/api/v10'}${route}`, {
          headers: { Authorization: options.token },
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
        if (!response.ok) throw new DiscordConnectionError(`Discord channel access failed (HTTP ${response.status})`);
        return response.json();
      },
    };
  }

  connect(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (!this.closed) throw new DiscordConnectionError('Discord connection already in progress');
    this.closed = false;
    this.ready = false;
    return new Promise<void>((resolve, reject) => {
      this.initialResolve = resolve;
      this.initialReject = reject;
      this.openSocket();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.ready = false;
    this.clearTimers();
    this.rejectInitial(new Error('Discord user Gateway closed'));
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
  }

  private openSocket(): void {
    if (this.closed) return;
    this.clearSocketTimer();
    const socket = this.options.socketFactory?.() ||
      new WebSocket(this.resumeUrl || this.options.gatewayUrl || 'wss://gateway.discord.gg/?v=10&encoding=json') as SocketLike;
    this.socket = socket;
    this.connectTimer = setTimeout(() => {
      this.fail(new DiscordConnectionError('Discord user Gateway connection timed out'));
    }, this.options.connectTimeoutMs ?? 20_000);

    socket.on('message', data => {
      if (!this.closed && this.socket === socket) this.handlePacket(data.toString());
    });
    socket.on('error', () => {
      if (this.closed || this.socket !== socket) return;
      if (this.sessionId) this.scheduleReconnect();
      else this.fail(new DiscordConnectionError('Discord user Gateway network error'));
    });
    socket.on('close', code => {
      if (!this.closed && this.socket === socket) this.handleClose(Number(code));
    });
  }

  private handlePacket(raw: string): void {
    let packet: any;
    try { packet = JSON.parse(raw); } catch {
      this.fail(new DiscordConnectionError('Invalid Discord Gateway payload; reconcile recent messages'));
      return;
    }
    if (!packet || typeof packet !== 'object') return;
    if (typeof packet.s === 'number') this.sequence = packet.s;

    if (packet.op === 10) {
      this.startHeartbeat(Math.max(1000, Number(packet.d?.heartbeat_interval || 41_250)));
      if (this.sessionId && this.sequence !== null) {
        this.send({ op: 6, d: { token: this.options.token, session_id: this.sessionId, seq: this.sequence } });
      } else {
        this.send({
          op: 2,
          d: {
            token: this.options.token,
            properties: { os: process.platform, browser: 'Discord Client', device: 'Discord Client' },
          },
        });
      }
      return;
    }
    if (packet.op === 11) {
      this.heartbeatAck = true;
      return;
    }
    if (packet.op === 1) {
      this.send({ op: 1, d: this.sequence });
      return;
    }
    if (packet.op === 7) {
      this.scheduleReconnect();
      return;
    }
    if (packet.op === 9) {
      if (this.sessionId && packet.d === true) {
        this.scheduleReconnect();
      } else if (this.sessionId) {
        this.fail(new DiscordConnectionError('Discord session expired; reconcile recent messages before restarting'));
      } else {
        this.fail(new DiscordConnectionError('Discord Gateway rejected authentication (opcode 9)'));
      }
      return;
    }
    if (packet.op === 0 && packet.t === 'READY') {
      if (this.sessionId) {
        this.fail(new DiscordConnectionError('Discord session was replaced; reconcile recent messages before restarting'));
        return;
      }
      this.ready = true;
      this.reconnectAttempts = 0;
      this.sessionId = packet.d?.session_id || null;
      if (typeof packet.d?.resume_gateway_url === 'string') {
        const url = new URL(packet.d.resume_gateway_url);
        if (url.protocol === 'wss:' && (url.hostname === 'discord.gg' || url.hostname.endsWith('.discord.gg'))) {
          url.searchParams.set('v', '10');
          url.searchParams.set('encoding', 'json');
          this.resumeUrl = url.toString();
        }
      }
      this.options.handlers.onReady();
      this.resolveInitial();
      return;
    }
    if (packet.op === 0 && packet.t === 'RESUMED') {
      this.ready = true;
      this.reconnectAttempts = 0;
      this.options.handlers.onReady();
      this.resolveInitial();
      return;
    }
    if (packet.op === 0) this.options.handlers.onDispatch(packet);
  }

  private handleClose(code: number): void {
    if (this.closed) return;
    if ([4004, 4007, 4009, 4010, 4011, 4012, 4013, 4014].includes(code)) {
      this.fail(new DiscordConnectionError(`Discord Gateway closed (code ${code}); check authentication or reconcile the expired session`));
      return;
    }
    if (!this.sessionId) {
      this.fail(new DiscordConnectionError(`Discord Gateway closed before READY (code ${code})`));
      return;
    }
    this.scheduleReconnect();
  }

  private startHeartbeat(interval: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatAck = true;
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAck) {
        this.scheduleReconnect();
        return;
      }
      this.heartbeatAck = false;
      this.send({ op: 1, d: this.sequence });
    }, interval);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    if (++this.reconnectAttempts > 5) {
      this.fail(new DiscordConnectionError('Discord reconnect limit reached; reconcile recent messages'));
      return;
    }
    this.ready = false;
    this.clearTimers();
    const oldSocket = this.socket;
    this.socket = null;
    oldSocket?.terminate();
    this.options.handlers.onReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.openSocket();
    }, this.options.reconnectDelayMs ?? 2000);
  }

  private send(payload: any): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }

  private fail(error: Error): void {
    this.closed = true;
    this.clearTimers();
    this.ready = false;
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
    this.rejectInitial(error);
    this.options.handlers.onError(error);
  }

  private resolveInitial(): void {
    const resolve = this.initialResolve;
    this.initialResolve = null;
    this.initialReject = null;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    resolve?.();
  }

  private rejectInitial(error: Error): void {
    const reject = this.initialReject;
    this.initialResolve = null;
    this.initialReject = null;
    reject?.(error);
  }

  private clearSocketTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearTimers(): void {
    this.clearSocketTimer();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }
}
