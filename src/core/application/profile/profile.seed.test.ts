import { describe, expect, it } from 'vitest';
import { USER_BIO_MAX_LENGTH, USER_MAX_LINKS, USER_NAME_MAX_LENGTH } from '@/config/user';
import { parseBitkitProfileSeed, parsePubkyAppProfileSeed } from './profile.seed';

// Paykit rc55 `PaykitProfile` as Bitkit publishes it (PubkyRepo.writeProfile →
// publishPaykitProfile): display_name + image_uri, name/bio/links/tags in extra.
// Authored from paykit-rs v0.1.0-rc55 and bitkit-android master sources; no live
// Bitkit capture exists yet.
const bitkitProfile = {
  display_name: 'Dusty Dolphin',
  image_uri: 'pubky://example/pub/bitkit.to/bitkit/wallet/blobs/0001',
  extra: {
    name: 'Dusty Dolphin',
    bio: 'Sells coffee',
    image: null,
    links: [
      { label: 'Website', url: 'https://example.com' },
      { label: 'Script', url: 'javascript:alert(1)' },
    ],
    tags: ['coffee'],
  },
};

describe('parseBitkitProfileSeed', () => {
  it('takes the name, bio and safe links from a Bitkit profile', () => {
    expect(parseBitkitProfileSeed(bitkitProfile)).toEqual({
      name: 'Dusty Dolphin',
      bio: 'Sells coffee',
      links: [{ title: 'Website', url: 'https://example.com' }],
    });
  });

  it('falls back to extra.name when display_name is missing', () => {
    expect(parseBitkitProfileSeed({ extra: { name: 'From Extra' } })?.name).toBe('From Extra');
  });

  it('returns null when the profile carries no usable field', () => {
    expect(parseBitkitProfileSeed({ display_name: '   ', image_uri: 'x' })).toBeNull();
    expect(parseBitkitProfileSeed('not a profile')).toBeNull();
    expect(parseBitkitProfileSeed(null)).toBeNull();
  });

  it('ignores fields of the wrong type instead of failing', () => {
    expect(parseBitkitProfileSeed({ display_name: 42, extra: { name: 'Typed', links: 'nope' } })).toEqual({
      name: 'Typed',
      bio: '',
      links: [],
    });
  });

  it('bounds every field to the Pubky App limits', () => {
    const seed = parseBitkitProfileSeed({
      display_name: 'n'.repeat(USER_NAME_MAX_LENGTH + 20),
      extra: {
        bio: 'b'.repeat(USER_BIO_MAX_LENGTH + 20),
        links: Array.from({ length: USER_MAX_LINKS + 3 }, (_, index) => ({
          label: `L${index}`,
          url: `https://example.com/${index}`,
        })),
      },
    });
    expect(seed?.name).toHaveLength(USER_NAME_MAX_LENGTH);
    expect(seed?.bio).toHaveLength(USER_BIO_MAX_LENGTH);
    expect(seed?.links).toHaveLength(USER_MAX_LINKS);
  });
});

describe('parsePubkyAppProfileSeed', () => {
  it('takes the name, bio and links from a Pubky App profile', () => {
    expect(
      parsePubkyAppProfileSeed({
        name: 'Alice',
        bio: 'Hi',
        image: null,
        links: [{ title: 'Site', url: 'https://alice.example' }],
        status: '',
      }),
    ).toEqual({ name: 'Alice', bio: 'Hi', links: [{ title: 'Site', url: 'https://alice.example' }] });
  });

  it('returns null for an empty profile', () => {
    expect(parsePubkyAppProfileSeed({ name: '', bio: '', links: [] })).toBeNull();
  });
});
