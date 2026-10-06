import { isIP } from 'node:net';
import { checkDnsSafety } from '@/core/services/nextjs/nextjs.utils';
import { isIpSafe } from '@/libs/network/network';

export class HomeserverFetchDenied extends Error {
  constructor() {
    super('homeserver_proof_invalid');
    this.name = 'HomeserverFetchDenied';
  }
}

export function assertSafeHomeserverUrl(url: URL): void {
  if (url.protocol !== 'https:') throw new HomeserverFetchDenied();
  if (url.username !== '' || url.password !== '') throw new HomeserverFetchDenied();
  if (url.search !== '' || url.hash !== '') throw new HomeserverFetchDenied();
  if (url.port !== '' && url.port !== '443') throw new HomeserverFetchDenied();
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (isIP(hostname)) throw new HomeserverFetchDenied();
}

export async function assertSafeHomeserverTarget(url: URL): Promise<void> {
  assertSafeHomeserverUrl(url);
  const dns = await checkDnsSafety(url.hostname);
  if (!dns.ok) throw new HomeserverFetchDenied();
  if (dns.addresses.some(({ address }) => !isIpSafe(address))) throw new HomeserverFetchDenied();
}

export const CLI_PROOF_PATH_PREFIX = '/pub/pubky.app/marketplace/v1/cli-grant-proofs/';

export function proofPath(challengeId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(challengeId)) {
    throw new HomeserverFetchDenied();
  }
  return `${CLI_PROOF_PATH_PREFIX}${challengeId}`;
}
