import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';

export class HubAgentBackupClient {
  private constructor(
    private readonly baseUrl: URL,
    private readonly tls: { ca: Buffer; cert: Buffer; key: Buffer },
  ) {}

  static async create(input: { url: string; caFile: string; certFile: string; keyFile: string }) {
    const [ca, cert, key] = await Promise.all([
      readFile(input.caFile),
      readFile(input.certFile),
      readFile(input.keyFile),
    ]);
    return new HubAgentBackupClient(new URL(input.url), { ca, cert, key });
  }

  private request<T>(path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const request = httpsRequest(
        {
          protocol: this.baseUrl.protocol,
          hostname: this.baseUrl.hostname,
          port: this.baseUrl.port || 443,
          method: 'POST',
          path: path,
          ca: this.tls.ca,
          cert: this.tls.cert,
          key: this.tls.key,
          rejectUnauthorized: true,
          servername: this.baseUrl.hostname,
          headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': payload.byteLength }
            : {},
          timeout: 30_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if ((response.statusCode ?? 500) >= 300) {
              reject(new Error(`Hub Agent ${path} failed: ${response.statusCode} ${text}`));
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('timeout', () => request.destroy(new Error(`Hub Agent ${path} timed out`)));
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  quiesce() {
    return this.request<{ token: string; state: 'quiesced'; at: string }>('/api/v1/quiesce');
  }

  resume(token: string) {
    return this.request<{ state: 'resumed' }>('/api/v1/resume', { token });
  }
}
