import { describe, expect, it } from 'vitest';
import { matchDatabases, matchScore } from './db-match';

describe('matchDatabases', () => {
  it('pairs services with their databases, ignoring shared words, each database once', () => {
    const services = ['core-promo-ultimate', 'core-user-auth-ultimate', 'core-user-auth-v2', 'core-payment-ultimate', 'core-payment-channel-new', 'krakend-api-gateway'];
    const dbs = ['promo_db', 'user_auth', 'user_auth_v2', 'payment', 'payment_channel', 'postgres_exporter'];
    expect(matchDatabases(services, dbs)).toEqual({
      'core-promo-ultimate': 'promo_db',
      'core-user-auth-ultimate': 'user_auth',
      'core-user-auth-v2': 'user_auth_v2',
      'core-payment-ultimate': 'payment',
      'core-payment-channel-new': 'payment_channel',
    });
  });

  it('scores word overlap', () => {
    expect(matchScore('core-promo-ultimate', 'core_promo')).toBe(1);
    expect(matchScore('core-tcico', 'billing')).toBe(0);
  });
});
