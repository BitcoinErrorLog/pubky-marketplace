#!/usr/bin/env node
// Prints the source commit of a running build from its image's org.opencontainers.image.revision
// label. Use it as <SVC>_RUNNING_COMMIT_CMD.
//
//   node running-commit.mjs image <registry/name@sha256:…>
//   node running-commit.mjs railway <project-id> <environment-id> <service-name-or-id>
//
// Public registries (ghcr.io, Docker Hub) need no login. For a private registry set
// REGISTRY_BASIC=<user>:<password-or-token> (Artifact Registry: oauth2accesstoken:$(gcloud auth print-access-token)).
// Nothing but the commit is printed on success.
import { execFileSync } from 'node:child_process';
import { parseBearerChallenge, parseImageRef } from './lib.mjs';

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

async function registryGet(registry, repository, path, accept, auth) {
  const target = `https://${registry}/v2/${repository}/${path}`;
  let response = await fetch(target, { headers: { accept, ...auth.headers }, signal: AbortSignal.timeout(20_000) });
  if (response.status === 401 && !auth.headers.authorization) {
    const challenge = parseBearerChallenge(response.headers.get('www-authenticate'));
    if (!challenge) throw new Error(`registry ${registry} refused anonymous access`);
    const tokenUrl = new URL(challenge.realm);
    if (challenge.service) tokenUrl.searchParams.set('service', challenge.service);
    tokenUrl.searchParams.set('scope', `repository:${repository}:pull`);
    // Credentials go only to the registry's own host (Docker Hub issues tokens from auth.docker.io).
    const trustedRealm =
      tokenUrl.protocol === 'https:' &&
      (tokenUrl.host === registry || (registry === 'registry-1.docker.io' && tokenUrl.host === 'auth.docker.io'));
    if (process.env.REGISTRY_BASIC && !trustedRealm)
      throw new Error(`refusing to send REGISTRY_BASIC to token host ${tokenUrl.host}`);
    const basic = process.env.REGISTRY_BASIC;
    const tokenResponse = await fetch(tokenUrl, {
      headers: basic ? { authorization: `Basic ${Buffer.from(basic).toString('base64')}` } : {},
      signal: AbortSignal.timeout(20_000),
    });
    if (!tokenResponse.ok) throw new Error(`registry token: HTTP ${tokenResponse.status}`);
    const body = await tokenResponse.json();
    auth.headers.authorization = `Bearer ${body.token ?? body.access_token}`;
    response = await fetch(target, { headers: { accept, ...auth.headers }, signal: AbortSignal.timeout(20_000) });
  }
  if (!response.ok) throw new Error(`registry ${path.split('/')[0]}: HTTP ${response.status}`);
  return response.json();
}

async function imageRevision(ref) {
  const { registry, repository, reference } = parseImageRef(ref);
  const auth = { headers: {} };
  let manifest = await registryGet(registry, repository, `manifests/${reference}`, MANIFEST_TYPES, auth);
  if (manifest.manifests) {
    const platform =
      manifest.manifests.find((m) => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64') ??
      manifest.manifests.find((m) => m.platform?.os !== 'unknown');
    if (!platform) throw new Error('image index has no linux manifest');
    manifest = await registryGet(registry, repository, `manifests/${platform.digest}`, MANIFEST_TYPES, auth);
  }
  const config = await registryGet(registry, repository, `blobs/${manifest.config.digest}`, '*/*', auth);
  const labels = config.config?.Labels ?? {};
  const revision = labels['org.opencontainers.image.revision'];
  if (!revision) throw new Error('image has no org.opencontainers.image.revision label');
  return revision;
}

function railwayImage(project, environment, service) {
  const run = (argv) => JSON.parse(execFileSync('railway', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const status = run(['service', 'status', '--json', '-p', project, '-e', environment, '-s', service]);
  if (status.stopped) throw new Error(`Railway service ${service} is stopped`);
  const deployments = run(['deployment', 'list', '--json', '-p', project, '-e', environment, '-s', service]);
  const live = deployments.find((d) => d.id === status.deploymentId);
  const image = live?.meta?.image;
  if (!image) throw new Error(`Railway deployment ${status.deploymentId} has no image (source build?)`);
  return image;
}

const [mode, ...rest] = process.argv.slice(2);
try {
  let image;
  if (mode === 'image' && rest.length === 1) image = rest[0];
  else if (mode === 'railway' && rest.length === 3) image = railwayImage(...rest);
  else {
    console.error('usage: running-commit.mjs image <ref> | railway <project> <environment> <service>');
    process.exit(2);
  }
  console.log(await imageRevision(image));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
