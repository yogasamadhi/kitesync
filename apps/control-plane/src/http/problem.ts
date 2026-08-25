import type { FastifyReply, FastifyRequest } from 'fastify';

export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    title: string,
    readonly detail?: string,
  ) {
    super(title);
  }
}

export function sendProblem(request: FastifyRequest, reply: FastifyReply, problem: HttpProblem) {
  return reply.status(problem.status).type('application/problem+json').send({
    type: 'about:blank',
    title: problem.message,
    status: problem.status,
    detail: problem.detail,
    instance: request.url,
    traceId: request.id,
    code: problem.code,
  });
}
