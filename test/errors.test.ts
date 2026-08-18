import { describe, expect, it } from 'vitest';
import { CorpayHttpError, explainForbidden, formatUnknownError, redactUrl } from '../src/errors.js';

function forbidden(path: string): CorpayHttpError {
  return new CorpayHttpError({
    status: 403,
    method: 'GET',
    url: `https://api.corpayone.com/external${path}`,
    payload: '<!DOCTYPE html><title>Forbidden</title>',
  });
}

describe('scope-gated 403s', () => {
  it('names the scope a departments read needs', () => {
    const message = explainForbidden(forbidden('/v1/teams/T1/departments'));
    expect(message).toMatch(/departments\.all/);
    // Says who can actually enable it. Selecting the scope in the developer
    // portal is not sufficient, so the message must not send people there.
    expect(message).toMatch(/Corpay support/);
    expect(message).toMatch(/not a broken endpoint/);
  });

  it('covers each scope-gated endpoint family', () => {
    const cases: Array<[string, RegExp]> = [
      ['/v2/creditaccounts/team/T1', /cardtransactions\.all/],
      ['/v1/payments/methods', /payments\.all/],
      ['/v1/teams/T1/members', /teams\.members\.list/],
      ['/v1/teams/T1/modules', /teams\.modules\.list/],
      ['/v2/expenses/E1/approvers', /expenses\.approvers\.read/],
      ['/v2/teams/T1/items', /items\.read/],
    ];
    for (const [path, expected] of cases) {
      expect(explainForbidden(forbidden(path))).toMatch(expected);
    }
  });

  it('leaves an unrelated 403 alone', () => {
    expect(explainForbidden(forbidden('/v2/expenses'))).toBeUndefined();
  });

  it('does not reinterpret other statuses', () => {
    const notFound = new CorpayHttpError({
      status: 404,
      method: 'GET',
      url: 'https://api.corpayone.com/external/v1/teams/T1/departments',
    });
    expect(explainForbidden(notFound)).toBeUndefined();
    expect(formatUnknownError(notFound)).toMatch(/HTTP 404/);
  });

  it('surfaces the explanation through formatUnknownError', () => {
    expect(formatUnknownError(forbidden('/v1/teams/T1/departments'))).toMatch(/departments\.all/);
  });
});

describe('redaction', () => {
  it('drops the query string so tokens never reach logs', () => {
    expect(redactUrl('https://api.corpayone.com/external/v2/expenses?teamId=T1&secret=x')).toBe(
      'https://api.corpayone.com/external/v2/expenses',
    );
  });

  it('handles a value that is not a url', () => {
    expect(redactUrl('not a url?with=query')).toBe('not a url');
  });
});

describe('scope explanation travels with the error', () => {
  it('replaces the HTML dump in the error message itself', () => {
    // The message matters on its own: a read tool lets the error propagate to
    // the MCP client without passing through formatUnknownError.
    const error = forbidden('/v2/creditaccounts/team/T1');
    expect(error.message).toMatch(/cardtransactions\.all/);
    expect(error.message).not.toMatch(/DOCTYPE/);
  });

  it('leaves an ordinary error message intact', () => {
    const error = new CorpayHttpError({
      status: 400,
      method: 'GET',
      url: 'https://api.corpayone.com/external/v2/expenses',
      payload: { errors: { count: ['must be between 10 and 100'] } },
    });
    expect(error.message).toMatch(/HTTP 400/);
    expect(error.message).toMatch(/between 10 and 100/);
  });
});
