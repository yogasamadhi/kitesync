import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { HubDesiredState, HubOperation, HubSnapshot } from '@kitesync/contracts';
import type { ControlPlaneConfig } from '../config.js';

export class HubAgentClient {
  constructor(private readonly config: ControlPlaneConfig) {}

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, this.config.hubAgentUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const requestImpl = url.protocol === 'https:' ? httpsRequest : httpRequest;

    return new Promise<T>((resolve, reject) => {
      const request = requestImpl(
        url,
        {
          method,
          headers: {
            Accept: 'application/json',
            ...(payload
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload),
                }
              : {}),
          },
          ...(url.protocol === 'https:'
            ? {
                ca: this.config.hubAgentCa,
                cert: this.config.hubAgentCert,
                key: this.config.hubAgentKey,
                rejectUnauthorized: true,
              }
            : {}),
          timeout: 30_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
              reject(
                new Error(
                  `Hub Agent ${method} ${path} failed with ${response.statusCode ?? 'no status'}: ${text.slice(0, 500)}`,
                ),
              );
              return;
            }
            try {
              resolve((text ? JSON.parse(text) : undefined) as T);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('timeout', () => request.destroy(new Error('Hub Agent request timed out')));
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  snapshot() {
    return this.request<HubSnapshot>('GET', '/api/v1/snapshot');
  }

  submit(desired: HubDesiredState) {
    return this.request<HubOperation>('PUT', '/api/v1/desired-state/' + desired.revision, desired);
  }

  operation(id: string) {
    return this.request<HubOperation>('GET', '/api/v1/operations/' + encodeURIComponent(id));
  }

  versions(folderId: string) {
    return this.request<{
      items: Array<{ path: string; versionTime: string; modifiedAt: string; sizeBytes: number }>;
    }>('GET', `/api/v1/folders/${encodeURIComponent(folderId)}/versions`);
  }

  restore(folderId: string, files: Array<{ path: string; versionTime: string }>) {
    return this.request<{ operationId: string; state: string }>(
      'POST',
      `/api/v1/folders/${encodeURIComponent(folderId)}/restore`,
      { files },
    );
  }
}
