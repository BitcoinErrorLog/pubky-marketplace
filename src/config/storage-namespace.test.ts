import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetEmbeddedForTests } from '@/libs/embedded/embedded';
import { setBasePath } from '@/test-utils/base-path';
import { setEmbedded } from '@/test-utils/embedded';
import { getStorageAdoptLegacy } from './storage-namespace';

const runtime = vi.hoisted(() => ({ override: undefined as boolean | undefined }));

vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>();
  return { ...actual, getStorageAdoptLegacyOverride: () => runtime.override };
});

describe('getStorageAdoptLegacy', () => {
  afterEach(() => {
    runtime.override = undefined;
    setBasePath('');
    setEmbedded(false);
    resetEmbeddedForTests();
  });

  it('adopts the legacy names of a Shop served from the origin root', () => {
    expect(getStorageAdoptLegacy()).toBe(true);
  });

  it("does not adopt them under a base path, where they are the host app's", () => {
    setBasePath('/shop');
    expect(getStorageAdoptLegacy()).toBe(false);
  });

  it('lets the deployer decide either way when the Shop is not embedded', () => {
    runtime.override = false;
    expect(getStorageAdoptLegacy()).toBe(false);
    setBasePath('/shop');
    runtime.override = true;
    expect(getStorageAdoptLegacy()).toBe(true);
  });

  it('never adopts while embedded, even if the deployer said yes', () => {
    runtime.override = true;
    setEmbedded(true);
    expect(getStorageAdoptLegacy()).toBe(false);
  });
});
