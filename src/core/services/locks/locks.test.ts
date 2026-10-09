import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppError } from '@/libs/error/error';
import { Logger } from '@/libs/logger/logger';
import { LocksGatewayService } from './locks';

const CREATOR = 'y'.repeat(52);
const READER = 'b'.repeat(52);
const BUNDLE_ID = '000G40R40M30E209185GR38E1W';

const sdkMocks = vi.hoisted(() => ({
  init: vi.fn(),
  generateBundleId: vi.fn(),
}));

vi.mock('locks-sdk-wasm', () => ({
  default: sdkMocks.init,
  BundleId: { generate: sdkMocks.generateBundleId },
}));

const paykitSetupConfig = vi.hoisted(() => ({ creatorParam: true }));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return {
    ...actual,
    getLocksUrl: () => 'https://locks.example.com',
    getPaykitSetupUrl: () => 'https://paykit.example.com/setup',
    getPaykitSetupCreatorParam: () => paykitSetupConfig.creatorParam,
  };
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function lifecycle(status: 'pending' | 'completed' = 'pending') {
  return {
    creator: `pubky${CREATOR}`,
    bundle_id: BUNDLE_ID,
    status,
    submitted_at: '2026-08-19T23:00:00.000Z',
    started_at: null,
    completed_at: status === 'completed' ? '2026-08-19T23:01:00.000Z' : null,
    failure_message: null,
  };
}

describe('LocksGatewayService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdkMocks.init.mockResolvedValue(undefined);
    sdkMocks.generateBundleId.mockReturnValue({ toString: () => BUNDLE_ID });
  });

  it('generates bundle ids through the vendored SDK and initializes the WASM module once', async () => {
    await expect(LocksGatewayService.generateBundleId()).resolves.toBe(BUNDLE_ID);
    await expect(LocksGatewayService.generateBundleId()).resolves.toBe(BUNDLE_ID);

    expect(sdkMocks.init).toHaveBeenCalledTimes(1);
    expect(sdkMocks.generateBundleId).toHaveBeenCalledTimes(2);
    // Identifier generation is local WASM — no Lock Server round trip.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('submits the canonical empty Paykit proof without invoice material', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(lifecycle()));

    await LocksGatewayService.submitPaykitProof({
      creatorPubky: CREATOR,
      readerPubky: READER,
      bundleId: BUNDLE_ID,
      lockResource: `pubky://${CREATOR}/pub/locks.app/lock.json`,
      criterionId: 'criterion-1',
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://locks.example.com/proof-bundles',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          submitted_proof_bundle: {
            version: 1,
            bundle_id: BUNDLE_ID,
            pubky_lock_resource: `pubky${CREATOR}/pub/locks.app/lock.json`,
            reader_public_key: `pubky${READER}`,
            proofs: [{ criterion_id: 'criterion-1', verifier_type: 'paykit-payment', payload: {} }],
          },
        }),
      }),
    );
  });

  it('rejects a lock resource that is not owned by the creator without any network call', async () => {
    await expect(
      LocksGatewayService.submitPaykitProof({
        creatorPubky: CREATOR,
        readerPubky: READER,
        bundleId: BUNDLE_ID,
        lockResource: `pubky://${READER}/pub/locks.app/lock.json`,
        criterionId: 'criterion-1',
      }),
    ).rejects.toMatchObject({ name: 'AppError', code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('looks up lifecycle and requests a credential without putting bearer ids in URLs', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(lifecycle('completed')))
      .mockResolvedValueOnce(jsonResponse({ credential: 'opaque-secret', expires_at: '2026-08-20T00:00:00.000Z' }));

    await expect(LocksGatewayService.lookupVerification(CREATOR, BUNDLE_ID)).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(LocksGatewayService.issueAccessCredential(CREATOR, BUNDLE_ID)).resolves.toMatchObject({
      credential: 'opaque-secret',
    });

    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://locks.example.com/verification-task-lookups');
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe('https://locks.example.com/access-credentials');
    expect(vi.mocked(fetch).mock.calls.flatMap((call) => String(call[0]))).not.toContain(BUNDLE_ID);
  });

  it('reads the durable-admission lifecycle fields (pubky/locks#72) and stays compatible without them', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({ ...lifecycle(), status_message: 'Reader wallet setup needed', terminal_reason: null }),
      )
      .mockResolvedValueOnce(jsonResponse(lifecycle()));

    await expect(LocksGatewayService.lookupVerification(CREATOR, BUNDLE_ID)).resolves.toMatchObject({
      status: 'pending',
      status_message: 'Reader wallet setup needed',
      terminal_reason: null,
    });
    const legacy = await LocksGatewayService.lookupVerification(CREATOR, BUNDLE_ID);
    expect(legacy.status).toBe('pending');
    expect(legacy.status_message).toBeUndefined();
  });

  it('reads admission_deadline_at and a terminal reason, and stays compatible without them (rc8)', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ ...lifecycle(), admission_deadline_at: '2026-08-19T23:10:00.000Z' }))
      .mockResolvedValueOnce(jsonResponse({ ...lifecycle(), status: 'expired', terminal_reason: 'proposal_expired' }))
      .mockResolvedValueOnce(jsonResponse(lifecycle()));

    await expect(LocksGatewayService.lookupVerification(CREATOR, BUNDLE_ID)).resolves.toMatchObject({
      admission_deadline_at: '2026-08-19T23:10:00.000Z',
    });
    await expect(LocksGatewayService.lookupVerification(CREATOR, BUNDLE_ID)).resolves.toMatchObject({
      status: 'expired',
      terminal_reason: 'proposal_expired',
    });
    const legacy = await LocksGatewayService.lookupVerification(CREATOR, BUNDLE_ID);
    expect(legacy.admission_deadline_at).toBeUndefined();
  });

  describe('refused submits', () => {
    const submit = () =>
      LocksGatewayService.submitPaykitProof({
        creatorPubky: CREATOR,
        readerPubky: READER,
        bundleId: BUNDLE_ID,
        lockResource: `pubky://${CREATOR}/pub/locks.app/lock.json`,
        criterionId: 'criterion-1',
      });
    const refused = (status: number, code: string) =>
      new Response(JSON.stringify({ error: { code, message: 'SENTINEL_SERVER_TEXT' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    it.each([
      [422, 'reader_pubky_unresolvable'],
      [502, 'paykit_invoice_creation_failed'],
      [404, 'content_lock_not_found'],
      [409, 'task_state_conflict'],
      [422, 'paykit_not_configured'],
      [422, 'unsupported_verifier_type'],
      [400, 'invalid_request'],
    ])('keeps the closed Lock Server code of a %i %s refusal for the buyer copy', async (status, code) => {
      vi.mocked(fetch).mockResolvedValueOnce(refused(status, code));

      const error = (await submit().catch((caught: unknown) => caught)) as AppError;

      expect(error.name).toBe('AppError');
      expect(error.context).toMatchObject({ statusCode: status, locksCode: code });
      expect(JSON.stringify(error.context)).not.toContain('SENTINEL_SERVER_TEXT');
    });

    it('drops any code it has no buyer copy for, and any body that is not a Lock Server error', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(refused(409, 'some_future_code'))
        .mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }))
        .mockResolvedValueOnce(new Response('null', { status: 500, headers: { 'content-type': 'application/json' } }));

      for (const status of [409, 502, 500]) {
        const error = (await submit().catch((caught: unknown) => caught)) as AppError;
        expect(error.context).toMatchObject({ statusCode: status });
        expect(error.context).not.toHaveProperty('locksCode');
      }
    });
  });

  it('finds a task by handle and reads 404 verification_task_not_found as no task', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(lifecycle()))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'verification_task_not_found' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }));

    await expect(LocksGatewayService.findVerification(CREATOR, BUNDLE_ID)).resolves.toMatchObject({
      status: 'pending',
    });
    await expect(LocksGatewayService.findVerification(CREATOR, BUNDLE_ID)).resolves.toBeNull();
    await expect(LocksGatewayService.findVerification(CREATOR, BUNDLE_ID)).rejects.toMatchObject({ name: 'AppError' });
    expect(
      vi.mocked(fetch).mock.calls.every((call) => call[0] === 'https://locks.example.com/verification-task-lookups'),
    ).toBe(true);
  });

  it('rejects malformed lifecycle and credential responses as INVALID_RESPONSE', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ ...lifecycle(), status: 'not-a-status' }))
      .mockResolvedValueOnce(jsonResponse({ credential: '' }));

    await expect(LocksGatewayService.lookupVerification(CREATOR, BUNDLE_ID)).rejects.toMatchObject({
      name: 'AppError',
      code: 'INVALID_RESPONSE',
    });
    await expect(LocksGatewayService.issueAccessCredential(CREATOR, BUNDLE_ID)).rejects.toMatchObject({
      name: 'AppError',
      code: 'INVALID_RESPONSE',
    });
  });

  it('uses bearer authorization only for guarded content retrieval', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    );

    await LocksGatewayService.fetchGuardedContent('orders/proof image.jpg', 'opaque-secret');

    expect(fetch).toHaveBeenCalledWith(
      'https://locks.example.com/priv-resources/content/orders/proof%20image.jpg',
      expect.objectContaining({ headers: { authorization: 'Bearer opaque-secret' } }),
    );
  });

  it('exchanges a legacy-connect completion for a frontend session', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ session_token: 'opaque-frontend-token', creator: `pubky${CREATOR}` }),
    );

    await expect(LocksGatewayService.createFrontendSession('one-time-code', 'opaque-state')).resolves.toEqual({
      session_token: 'opaque-frontend-token',
      creator: `pubky${CREATOR}`,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://locks.example.com/frontend-sessions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ code: 'one-time-code', state: 'opaque-state' }),
      }),
    );
  });

  it('rejects a malformed frontend session response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ token: 'wrong-shape' }));

    await expect(LocksGatewayService.createFrontendSession('one-time-code', 'opaque-state')).rejects.toMatchObject({
      name: 'AppError',
    });
  });

  it('does not put a truncated access-credential body into error context', async () => {
    const sentinel = 'locks-access-credential-sentinel';
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(`{"credential":"${sentinel}","expires_at":"`, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const loggerError = vi.spyOn(Logger, 'error');

    const error = (await LocksGatewayService.issueAccessCredential(CREATOR, BUNDLE_ID).catch(
      (caught: unknown) => caught,
    )) as AppError;

    expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(JSON.stringify(error.context)).not.toContain(sentinel);
    expect(error.context).not.toHaveProperty('responseText');
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(sentinel);
    loggerError.mockRestore();
  });

  it('does not put a truncated frontend-session body into error context', async () => {
    const sentinel = 'locks-frontend-session-sentinel';
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(`{"session_token":"${sentinel}","creator":"pubky`, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const loggerError = vi.spyOn(Logger, 'error');

    const error = (await LocksGatewayService.createFrontendSession('one-time-code', 'opaque-state').catch(
      (caught: unknown) => caught,
    )) as AppError;

    expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(JSON.stringify(error.context)).not.toContain(sentinel);
    expect(error.context).not.toHaveProperty('responseText');
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(sentinel);
    loggerError.mockRestore();
  });

  it('revalidates a creator frontend session without excerpting the bearer', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        creator: `pubky${CREATOR}`,
        authorized: true,
        auth_kind: 'legacy-cookie',
        granted_scopes: ['/pub/locks.app/:rw'],
        session_expires_at: null,
      }),
    );

    await expect(LocksGatewayService.getCreatorAuthorityStatus('session-token')).resolves.toEqual({
      creator: `pubky${CREATOR}`,
      authorized: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://locks.example.com/creator/authority-status',
      expect.objectContaining({
        method: 'GET',
        headers: { authorization: 'Bearer session-token' },
      }),
    );
  });

  it('does not put a truncated authority-status body into error context', async () => {
    const sentinel = 'locks-authority-status-sentinel';
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(`{"creator":"${sentinel}","authorized":tru`, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const loggerError = vi.spyOn(Logger, 'error');

    const error = (await LocksGatewayService.getCreatorAuthorityStatus('session-token').catch(
      (caught: unknown) => caught,
    )) as AppError;

    expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(JSON.stringify(error.context)).not.toContain(sentinel);
    expect(error.context).not.toHaveProperty('responseText');
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(sentinel);
    loggerError.mockRestore();
  });

  it('reads the creator-keyed authority status without a bearer', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ creator: `pubky${CREATOR}`, authorized: true }));

    await expect(LocksGatewayService.getPublicCreatorAuthorityStatus(CREATOR)).resolves.toEqual({
      creator: `pubky${CREATOR}`,
      authorized: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      `https://locks.example.com/creators/pubky${CREATOR}/authority-status`,
      expect.objectContaining({ method: 'GET' }),
    );
    const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toBeUndefined();
  });

  it('resolves null when the Lock Server does not serve the creator-keyed status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 404 }));

    await expect(LocksGatewayService.getPublicCreatorAuthorityStatus(CREATOR)).resolves.toBeNull();
  });

  it('rejects a creator-keyed status error instead of reading it as not connected', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'internal_error', message: 'internal error' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(LocksGatewayService.getPublicCreatorAuthorityStatus(CREATOR)).rejects.toBeTruthy();
  });

  it('builds the legacy connect URL with postmessage delivery', () => {
    expect(
      LocksGatewayService.buildLegacyConnectUrl('https://shop.pubky.app/marketplace/settings', 'opaque-state'),
    ).toBe(
      'https://locks.example.com/connect?return_to=https%3A%2F%2Fshop.pubky.app%2Fmarketplace%2Fsettings&state=opaque-state&delivery=postmessage',
    );
  });

  it('builds exact-origin Paykit setup callbacks with the creator the paykit-server fork requires', () => {
    paykitSetupConfig.creatorParam = true;
    expect(
      LocksGatewayService.buildPaykitSetupUrl(
        'https://app.example.com/marketplace/settings',
        'opaque-state',
        'gy1wnkhfwezwdnawnur1bc3kw1x3jf5ggjj3cm37e31i5ntq3pco',
      ),
    ).toBe(
      'https://paykit.example.com/setup?return_to=https%3A%2F%2Fapp.example.com%2Fmarketplace%2Fsettings&state=opaque-state&creator=gy1wnkhfwezwdnawnur1bc3kw1x3jf5ggjj3cm37e31i5ntq3pco',
    );
  });

  // Upstream pubky/paykit-server `http/setup.rs::parse_setup_query` (master
  // 722ef26, feat/lock-payment-draining 7f1fec9) accepts exactly one
  // `return_to` and one `state` and answers 400 invalid_request otherwise.
  it('builds the upstream Paykit setup URL with only return_to and state', () => {
    paykitSetupConfig.creatorParam = false;
    try {
      const built = LocksGatewayService.buildPaykitSetupUrl(
        'https://app.example.com/marketplace/settings',
        'opaque-state',
        'gy1wnkhfwezwdnawnur1bc3kw1x3jf5ggjj3cm37e31i5ntq3pco',
      );
      expect(built).toBe(
        'https://paykit.example.com/setup?return_to=https%3A%2F%2Fapp.example.com%2Fmarketplace%2Fsettings&state=opaque-state',
      );
      expect([...new URL(built).searchParams.keys()]).toEqual(['return_to', 'state']);
    } finally {
      paykitSetupConfig.creatorParam = true;
    }
  });
});
