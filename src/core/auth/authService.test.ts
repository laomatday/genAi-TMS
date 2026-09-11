import { describe, expect, it } from 'vitest';
import { LOGIN_EMAIL_DOMAINS } from '@/shared/constants';
import { buildLoginEmailCandidates } from './authService';

describe('buildLoginEmailCandidates', () => {
  it('tries every configured company domain when given a bare login id', () => {
    expect(buildLoginEmailCandidates('nghia')).toEqual(
      LOGIN_EMAIL_DOMAINS.map((domain) => `nghia@${domain}`),
    );
  });

  it('normalizes case and surrounding whitespace before building candidates', () => {
    expect(buildLoginEmailCandidates('  Nghia  ')).toEqual(
      LOGIN_EMAIL_DOMAINS.map((domain) => `nghia@${domain}`),
    );
  });

  it('uses the id as-is (lowercased) when it already looks like a full email', () => {
    expect(buildLoginEmailCandidates('Nghia@OtherCompany.com')).toEqual(['nghia@othercompany.com']);
  });
});
