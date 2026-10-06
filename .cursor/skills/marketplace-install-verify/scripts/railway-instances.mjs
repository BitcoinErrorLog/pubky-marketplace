#!/usr/bin/env node
// Prints how many replicas of a Railway service are running: the sum of the configured replica
// counts over its active deployments. Use it as PAYKIT_INSTANCE_COUNT_CMD for a Railway stack.
//
//   node railway-instances.mjs <project-id> <environment-id> <service-name>
import { execFileSync } from 'node:child_process';

const [project, environment, serviceName] = process.argv.slice(2);
if (!serviceName) {
  console.error('usage: railway-instances.mjs <project-id> <environment-id> <service-name>');
  process.exit(2);
}
const status = JSON.parse(
  execFileSync('railway', ['status', '--json', '-p', project, '-e', environment], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
);
const environmentNode = status.environments.edges.map((e) => e.node).find((n) => n.id === environment);
const instance = environmentNode?.serviceInstances.edges.map((e) => e.node).find((n) => n.serviceName === serviceName);
if (!instance) {
  console.error(`service ${serviceName} not found in environment ${environment}`);
  process.exit(1);
}
const replicas = (deployment) => {
  const deploy = deployment.meta?.serviceManifest?.deploy ?? {};
  const regions = Object.values(deploy.multiRegionConfig ?? {});
  if (regions.length) return regions.reduce((sum, region) => sum + (region?.numReplicas ?? 1), 0);
  return deploy.numReplicas ?? 1;
};
console.log((instance.activeDeployments ?? []).reduce((sum, deployment) => sum + replicas(deployment), 0));
