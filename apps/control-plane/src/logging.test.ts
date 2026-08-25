import { describe, expect, it } from 'vitest';
import { safeErrorLog } from './logging.js';

describe('safeErrorLog', () => {
  it('does not serialize attached TLS or request objects', () => {
    const error = Object.assign(new Error('certificate name mismatch'), {
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
      cert: { raw: Buffer.from('certificate'), privateContext: 'must-not-log' },
      request: { headers: { authorization: 'must-not-log' } },
    });
    expect(safeErrorLog(error)).toEqual({
      name: 'Error',
      message: 'certificate name mismatch',
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });
  });
});
