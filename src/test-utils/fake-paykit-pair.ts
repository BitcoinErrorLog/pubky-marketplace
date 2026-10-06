import { asOpaque } from './type-assertions';

/**
 * A shared in-memory stand-in for the paykit-wasm binding that lets two
 * accounts in one test process reach each other: receiver markers, the
 * handshake (initiate, answer, complete) and one ordered mailbox per
 * direction. Every handle is bound to the session that created it, so the
 * peer of a link is the account on the other end, never anything a message
 * says. Like the binding, a link handle keeps its own read position and
 * advances it when it returns a batch; its snapshot records that position,
 * so a handle restored from an older snapshot reads again what came after.
 *
 * The cryptography is not simulated here; it is proven against the real
 * artifact in `paykit-messaging.realcrypto.test.ts`.
 */
export function createFakePaykitPair() {
  const markers = new Map<string, { receiverPath: string; noisePublicKey: string }>();
  // `${initiator}>${responder}` → answered by the responder yet?
  const initiations = new Map<string, boolean>();
  // `${from}>${to}` → every message sent in that direction, in order.
  const mailboxes = new Map<string, string[]>();
  const log: string[] = [];
  let keyCounter = 0;

  const encode = (value: object) => new TextEncoder().encode(JSON.stringify(value));
  const decode = (bytes: Uint8Array) =>
    JSON.parse(new TextDecoder().decode(bytes)) as {
      owner: string;
      peer: string;
      role: string;
      remoteKey: string;
      cursor?: number;
    };

  class FakeSessionHandle {
    constructor(private readonly owner: string) {}
    pubky() {
      return this.owner;
    }
    exportSession() {
      return `exported-session:${this.owner}`;
    }
    free() {}
  }

  // Like the binding, a link reports the counterparty key it was created
  // with, and its snapshot carries that key.
  class FakeLink {
    constructor(
      private readonly owner: string,
      private readonly peer: string,
      private readonly remoteKey: string,
      private cursor = 0,
    ) {}
    remoteNoisePublicKey() {
      return this.remoteKey;
    }
    async sendPrivateApplicationMessageJson(rawJson: string) {
      if (new TextEncoder().encode(rawJson).byteLength > 1000) throw new Error('exceeds max Noise message size');
      const key = `${this.owner}>${this.peer}`;
      mailboxes.set(key, [...(mailboxes.get(key) ?? []), rawJson]);
      log.push(`send ${this.owner.slice(0, 4)}>${this.peer.slice(0, 4)}`);
    }
    async receivePrivateApplicationMessages() {
      const box = mailboxes.get(`${this.peer}>${this.owner}`) ?? [];
      const from = this.cursor;
      this.cursor = box.length;
      log.push(`receive ${this.owner.slice(0, 4)}<${this.peer.slice(0, 4)} ${box.length - from}`);
      return box.slice(from).map((rawJson) => ({ rawJson }));
    }
    snapshot() {
      return encode({
        owner: this.owner,
        peer: this.peer,
        role: 'link',
        remoteKey: this.remoteKey,
        cursor: this.cursor,
      });
    }
    async close() {}
    free() {}
  }

  class FakeHandshake {
    private step = 0;
    constructor(
      private readonly owner: string,
      private readonly peer: string,
      private readonly role: 'initiator' | 'responder',
      private readonly remoteKey: string,
    ) {}
    async advance() {
      if (this.role === 'initiator') {
        return initiations.get(`${this.owner}>${this.peer}`)
          ? { status: 'complete', link: new FakeLink(this.owner, this.peer, this.remoteKey) }
          : { status: 'pending' };
      }
      const key = `${this.peer}>${this.owner}`;
      if (initiations.get(key) === false) {
        initiations.set(key, true);
        this.step += 1;
        return { status: 'complete', link: new FakeLink(this.owner, this.peer, this.remoteKey) };
      }
      return { status: 'pending' };
    }
    snapshot() {
      return encode({
        owner: this.owner,
        peer: this.peer,
        role: this.role,
        remoteKey: this.remoteKey,
        step: this.step,
      });
    }
    setMaxRecoveryAttempts() {}
    free() {}
  }

  class FakePubkyClient {
    static testnet() {
      return new FakePubkyClient();
    }
    startAuthFlow() {
      throw new Error('The journey fake signs in through the cookie resume only.');
    }
    async restoreSession(exported: string) {
      return new FakeSessionHandle(exported.replace('exported-session:', ''));
    }
    async resumeSessionFromCookie(pubky: string) {
      return new FakeSessionHandle(pubky);
    }
  }

  const sessionOwner = (session: unknown) => (session as FakeSessionHandle).pubky();

  const binding = {
    default: async () => undefined,
    PubkyClient: FakePubkyClient,
    generateNoiseSecretKey: () => {
      keyCounter += 1;
      return new Uint8Array(32).fill(keyCounter);
    },
    noisePublicKeyFromSecret: (secret: Uint8Array) => `${'n'.repeat(50)}${String(secret[0]).padStart(2, '0')}`,
    publishReceiverMarker: async (session: unknown, path: string, noisePublicKey: string) => {
      markers.set(sessionOwner(session), { receiverPath: path, noisePublicKey });
    },
    getReceiverMarker: async (_client: unknown, ownerPubky: string) => markers.get(ownerPubky),
    listPaykitReceiverPaths: async (_client: unknown, ownerPubky: string) =>
      markers.has(ownerPubky) ? [markers.get(ownerPubky)?.receiverPath] : [],
    initiateEncryptedLink: (session: unknown, _secret: unknown, peer: string, peerKey: string) => {
      const owner = sessionOwner(session);
      if (!initiations.has(`${owner}>${peer}`)) initiations.set(`${owner}>${peer}`, false);
      log.push(`initiate ${owner.slice(0, 4)}>${peer.slice(0, 4)}`);
      return new FakeHandshake(owner, peer, 'initiator', peerKey);
    },
    acceptEncryptedLink: (session: unknown, _secret: unknown, peer: string, peerKey: string) =>
      new FakeHandshake(sessionOwner(session), peer, 'responder', peerKey),
    restoreEncryptedLink: async (session: unknown, _secret: unknown, peer: string, ...rest: unknown[]) => {
      const snapshot = decode(rest[rest.length - 1] as Uint8Array);
      if (snapshot.owner !== sessionOwner(session) || snapshot.peer !== peer) throw new Error('snapshot mismatch');
      return new FakeLink(snapshot.owner, snapshot.peer, snapshot.remoteKey, snapshot.cursor ?? 0);
    },
    restoreEncryptedLinkHandshake: async (session: unknown, _secret: unknown, peer: string, ...rest: unknown[]) => {
      const snapshot = decode(rest[rest.length - 1] as Uint8Array);
      if (snapshot.owner !== sessionOwner(session) || snapshot.peer !== peer) throw new Error('snapshot mismatch');
      return new FakeHandshake(
        snapshot.owner,
        snapshot.peer,
        snapshot.role as 'initiator' | 'responder',
        snapshot.remoteKey,
      );
    },
    maxNoiseMessageLen: () => 1000,
    noiseTagLen: () => 16,
  };

  return {
    module: asOpaque<typeof import('paykit-wasm')>(binding),
    log,
    /** The receiver marker an account currently publishes, as the fake homeserver holds it. */
    marker: (pubky: string) => markers.get(pubky),
    /** Every message one account ever sent another, as raw JSON. */
    sent: (from: string, to: string) => [...(mailboxes.get(`${from}>${to}`) ?? [])],
    /** Delivers raw JSON from `from` to `to` as if `from`'s runtime had sent it over their link. */
    inject: (from: string, to: string, rawJson: string) => {
      const key = `${from}>${to}`;
      mailboxes.set(key, [...(mailboxes.get(key) ?? []), rawJson]);
    },
  };
}
