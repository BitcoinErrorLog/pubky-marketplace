const Z32_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769';

export const PUBKY_REDACTED = '[redacted: pubky identifier]';
export const EMAIL_REDACTED = '[redacted: email]';
export const PHONE_REDACTED = '[redacted: phone]';
export const SENSITIVE_VALUE_REDACTED = '[redacted: sensitive field]';
export const SENTRY_LIMIT_REDACTED = '[redacted:limit]';
export const SENTRY_REDACTION_MAX_DEPTH = 20;
export const SENTRY_REDACTION_MAX_NODES = 1_000;
export const SENTRY_REDACTION_MAX_STRING_LENGTH = 16_384;

// Lookaround on the z32 alphabet (not `\b`): `_` is a JS word character, so
// `conversation:{seller52}_{buyer52}_{listingId}` would otherwise keep both pubkys.
export const RAW_PUBKY_PATTERN = new RegExp(`(?<![${Z32_ALPHABET}])[${Z32_ALPHABET}]{52}(?![${Z32_ALPHABET}])`, 'gi');
export const PUBKY_URI_PATTERN = /\bpubky:\/\/[^\s"'<>]+/gi;
export const PUBKY_HTTP_HOST_PATTERN = /\bhttps?:\/\/_pubky\.[^\s"'<>]+/gi;
export const PUBKY_COMPACT_URI_PATTERN = new RegExp(`\\bpubky[${Z32_ALPHABET}]{52}(?:\\/[^\\s"'<>]*)?`, 'gi');
export const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
export const PHONE_PATTERN = /\+?\d[\d\s().-]{7,}\d/g;
export const NEXUS_POST_TAGS_PATH_PATTERN = /^\/v0\/post\/[^/]+\/[^/]+\/tags$/;

export const SENSITIVE_CONTEXT_KEYS = new Set([
  'accesstoken',
  'apikey',
  'auth',
  'authorization',
  'avatar',
  'address',
  'bio',
  'clientsecret',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'deliveryaddress',
  'displayname',
  'email',
  'file',
  'firstname',
  'image',
  'key',
  'lastname',
  'name',
  'password',
  'passwd',
  'phone',
  'phonenumber',
  'privatekey',
  'publickey',
  'pubky',
  // Raw response-body excerpts (e.g. `responseText` from the generic HTTP
  // parse error) can carry endpoint-returned personal data; never ship them.
  'responsetext',
  'refreshtoken',
  'secret',
  'secretkey',
  'sessiontoken',
  'setcookie',
  'signature',
  'token',
  'user',
  'userid',
  'username',
  'xapikey',
]);

export const PUBKY_IDENTIFIER_KEYS = new Set([
  'author',
  'authorid',
  'followee',
  'follower',
  'mutee',
  'muter',
  'taggerid',
]);
