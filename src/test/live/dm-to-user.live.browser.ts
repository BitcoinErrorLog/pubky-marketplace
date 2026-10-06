// LIVE one-sided messaging proof: a persistent identity initiates an
// encrypted link to a REAL user's account on the deployed staging network and
// sends a DM (plus a listing chat message when a listing id is supplied).
//
// Uses the RAW binding with a PERSISTENT noise secret (PAYKIT_DM_NOISE hex):
// regenerating the receiver key per run rotates the published marker under
// the counterparty's feet mid-handshake, which is a test-harness artifact a
// real client (persistent storage) never produces.
//
//   PAYKIT_DM_SECRET=<identity hex> PAYKIT_DM_NOISE=<noise hex> \
//   PAYKIT_DM_TARGET=<z32> npm run test:marketplace:dm
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDmMessage } from '@/libs/messaging/dm-contracts';

declare const __DM_SECRET_HEX__: string;
declare const __DM_NOISE_HEX__: string;
declare const __DM_TARGET_PUBKY__: string;

const RECEIVER_PATH = 'marketplace/wallet';

let wasm: typeof import('paykit-wasm');

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('live DM to a real user on the deployed staging network', () => {
  beforeAll(async () => {
    wasm = await import('paykit-wasm');
    await wasm.default();
  });

  it('initiates the encrypted link and delivers a DM', async () => {
    expect(__DM_SECRET_HEX__).not.toBe('');
    expect(__DM_NOISE_HEX__).not.toBe('');
    expect(__DM_TARGET_PUBKY__).not.toBe('');

    const client = new wasm.PubkyClient();
    const session = (await client.signinWithSecret(
      hexToBytes(__DM_SECRET_HEX__),
    )) as import('paykit-wasm').SessionHandle;
    const me = session.pubky();
    console.info(`[dm-live] signed in as ${me}`);

    const noiseSecret = hexToBytes(__DM_NOISE_HEX__);
    const noisePublic = wasm.noisePublicKeyFromSecret(noiseSecret);
    await wasm.publishReceiverMarker(session, RECEIVER_PATH, noisePublic, true, false, false, false);
    console.info(`[dm-live] marker published (stable key ${noisePublic.slice(0, 12)}…)`);

    const targetMarker = (await wasm.getReceiverMarker(client, __DM_TARGET_PUBKY__, RECEIVER_PATH)) as {
      receiverPath: string;
      noisePublicKey: string;
    } | null;
    expect(targetMarker, 'the target has no receiver marker — they must enable messaging first').toBeTruthy();
    console.info(`[dm-live] target marker found (${targetMarker?.noisePublicKey.slice(0, 12)}…)`);

    const handshake = wasm.initiateEncryptedLink(
      session,
      noiseSecret,
      __DM_TARGET_PUBKY__,
      targetMarker!.noisePublicKey,
      RECEIVER_PATH,
      targetMarker!.receiverPath,
      client,
    );

    let link: import('paykit-wasm').EncryptedLinkHandle | null = null;
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline && !link) {
      const progress = (await handshake.advance()) as {
        status: string;
        link?: import('paykit-wasm').EncryptedLinkHandle;
      };
      if (progress.status === 'complete' && progress.link) {
        link = progress.link;
        break;
      }
      console.info(`[dm-live] handshake: ${progress.status} — waiting for the counterparty…`);
      await sleep(5_000);
    }
    expect(link, 'handshake did not complete — is the counterparty online with the app open?').toBeTruthy();
    console.info('[dm-live] link READY');

    const dm = buildDmMessage({
      eventId: crypto.randomUUID(),
      sentAt: Date.now(),
      body: 'Encrypted DM received in the real app UI — Noise XX end to end. — Fable',
    });
    await link!.sendPrivateApplicationMessageJson(dm.json);
    console.info('[dm-live] general DM SENT');
  });
});
