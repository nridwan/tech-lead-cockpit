import { execFile } from 'node:child_process';

import { KEYCHAIN_PREFIX } from './paths.ts';

// Under a profile (TLC_PROFILE) these become tech-lead-cockpit-<profile>.*, so the real tokens are untouched.
export const CONFLUENCE_SERVICE = `${KEYCHAIN_PREFIX}.confluence`;
export const JIRA_SERVICE = `${KEYCHAIN_PREFIX}.jira`;
export const INFERHUB_SERVICE = `${KEYCHAIN_PREFIX}.inferhub`;
export const TEAMS_SERVICE = `${KEYCHAIN_PREFIX}.teams`;
export const GITLAB_SERVICE = `${KEYCHAIN_PREFIX}.gitlab`;
export const NINEROUTER_SERVICE = `${KEYCHAIN_PREFIX}.9router`;
export const FIGMA_SERVICE = `${KEYCHAIN_PREFIX}.figma`;

/**
 * Reads a secret from the macOS login Keychain. Read on every call (no caching) so a
 * revoked or rotated token takes effect immediately. The value is never logged.
 */
export function readKeychain(service: string, account = 'default'): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', service, '-a', account, '-w'], { timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(null);
      const value = stdout.trim();
      resolve(value || null);
    });
  });
}

/**
 * Saves a secret to the macOS login Keychain.
 */
export function writeKeychain(service: string, value: string, account = 'default'): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value], { timeout: 10_000 }, (err) => {
      resolve(!err);
    });
  });
}

/**
 * Deletes a secret from the macOS login Keychain.
 */
export function deleteKeychain(service: string, account = 'default'): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('security', ['delete-generic-password', '-s', service, '-a', account], { timeout: 10_000 }, (err) => {
      resolve(!err);
    });
  });
}
