import { z } from 'zod';
import {
  USER_BIO_MAX_LENGTH,
  USER_LINK_LABEL_MAX_LENGTH,
  USER_LINK_URL_MAX_LENGTH,
  USER_MAX_LINKS,
  USER_NAME_MAX_LENGTH,
} from '@/config/user';
import { getSafeExternalUrl } from '@/libs/utils/safeExternalUrl';
import type { TProfileSeed } from './profile.types';

/** The Pubky App profile. Present means the account already finished onboarding elsewhere. */
export const PUBKY_APP_PROFILE_PATH = '/pub/pubky.app/profile.json';

/**
 * Bitkit's public profile, newest layout first: Paykit rc55 writes under the
 * `bitkit/wallet` receiver, earlier Paykit releases (Bitkit 2.4.x store
 * builds) at the namespace root. Both use the `bitkit.to` mainnet namespace.
 */
export const BITKIT_PROFILE_PATHS = [
  '/pub/bitkit.to/bitkit/wallet/profile.json',
  '/pub/bitkit.to/profile.json',
] as const;

const optionalText = z
  .unknown()
  .optional()
  .transform((value) => (typeof value === 'string' ? value.trim() : ''));

const linkSchema = z
  .object({ title: optionalText, label: optionalText, url: optionalText })
  .passthrough()
  .transform(({ title, label, url }) => ({ title: title || label, url }));

const linksSchema = z
  .unknown()
  .optional()
  .transform((value) => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      const parsed = linkSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
  });

const pubkyAppProfileSchema = z.object({ name: optionalText, bio: optionalText, links: linksSchema }).passthrough();

/** Paykit `PaykitProfile` (`display_name`, `image_uri`, `extra`); Bitkit keeps name, bio and links in `extra`. */
const bitkitProfileSchema = z
  .object({
    display_name: optionalText,
    extra: z
      .unknown()
      .optional()
      .transform((value) => pubkyAppProfileSchema.safeParse(value ?? {}))
      .transform((parsed) => (parsed.success ? parsed.data : { name: '', bio: '', links: [] })),
  })
  .passthrough();

function toSeed({ name, bio, links }: { name: string; bio: string; links: { title: string; url: string }[] }) {
  const seed: TProfileSeed = {
    name: name.slice(0, USER_NAME_MAX_LENGTH),
    bio: bio.slice(0, USER_BIO_MAX_LENGTH),
    links: links
      .flatMap(({ title, url }) => {
        const safeUrl = url.length <= USER_LINK_URL_MAX_LENGTH ? getSafeExternalUrl(url) : null;
        return title && safeUrl ? [{ title: title.slice(0, USER_LINK_LABEL_MAX_LENGTH), url: safeUrl }] : [];
      })
      .slice(0, USER_MAX_LINKS),
  };
  return seed.name || seed.bio || seed.links.length > 0 ? seed : null;
}

/** Name, bio and links from a Pubky App `profile.json`, or null when it carries none. */
export function parsePubkyAppProfileSeed(json: unknown): TProfileSeed | null {
  const parsed = pubkyAppProfileSchema.safeParse(json);
  return parsed.success ? toSeed(parsed.data) : null;
}

/** Name, bio and links from a Bitkit (Paykit) profile, or null when it carries none. */
export function parseBitkitProfileSeed(json: unknown): TProfileSeed | null {
  const parsed = bitkitProfileSchema.safeParse(json);
  if (!parsed.success) return null;
  const { display_name: displayName, extra } = parsed.data;
  return toSeed({ name: displayName || extra.name, bio: extra.bio, links: extra.links });
}
