import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../db/index.js';
import { updateReleases } from '../db/schema.js';
import { HttpProblem } from './problem.js';

function compareVersions(left: string, right: string) {
  const parse = (value: string) => value.split(/[.+-]/, 3).map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function requireSupportedDesktopVersion(db: Database) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const [release] = await db
      .select({ minimumClientVersion: updateReleases.minimumClientVersion })
      .from(updateReleases)
      .where(
        and(eq(updateReleases.channel, 'stable'), isNotNull(updateReleases.minimumClientVersion)),
      )
      .orderBy(desc(updateReleases.publishedAt))
      .limit(1);
    if (!release?.minimumClientVersion) return;
    const raw = request.headers['x-kitesync-client-version'];
    const version = Array.isArray(raw) ? raw[0] : raw;
    if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
      throw new HttpProblem(
        426,
        'CLIENT_UPDATE_REQUIRED',
        `KiteSync ${release.minimumClientVersion} or newer is required for configuration changes`,
      );
    }
    if (compareVersions(version, release.minimumClientVersion) < 0) {
      throw new HttpProblem(
        426,
        'CLIENT_UPDATE_REQUIRED',
        `KiteSync ${release.minimumClientVersion} or newer is required for configuration changes`,
      );
    }
  };
}
