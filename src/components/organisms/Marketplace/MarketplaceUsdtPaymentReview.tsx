'use client';

import { LoaderCircle } from 'lucide-react';
import { Controller, type UseFormReturn } from 'react-hook-form';
import { Button, buttonVariants } from '@/atoms/Button/Button';
import { Input } from '@/atoms/Input/Input';
import { Typography } from '@/atoms/Typography/Typography';
import type {
  SellerPaymentResolutionForm,
  SellerPaymentResolutionSubmission,
} from '@/hooks/useMarketplaceSellerPaymentReview/useMarketplaceSellerPaymentReviewForm';
import {
  isUsdtResolutionReferenceInput,
  USDT_PAYMENT_REVIEW_COPY,
  usdtReviewRefundAddress,
  usdtReviewTotalLine,
} from '@/libs/commerce/usdt-payment-review';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';

/**
 * The seller's manual-review resolution of a USDT payment. It mirrors the
 * Bitcoin panel (same outcomes, same endpoint) with the USDT differences: the
 * order total shows beside its parity USDT amount, and a refund is recorded
 * with the Arbitrum transaction hash of the transfer the seller sent from
 * Bitkit to the address the buyer confirmed. The Shop never checks that
 * transfer, so the panel says the refund is recorded by the seller.
 *
 * Shown for an order's own USDT asset, never behind the new-offer flag, so an
 * existing USDT order can always be resolved.
 */
export function SellerUsdtResolutionReview({
  order,
  enteredAt,
  form,
  isSubmitting,
  error,
  onResolve,
  allowPaid = true,
}: {
  order: MarketplaceOrder;
  enteredAt?: string | null;
  form: UseFormReturn<SellerPaymentResolutionForm, unknown, SellerPaymentResolutionSubmission>;
  isSubmitting: boolean;
  error: string | null;
  onResolve: () => void;
  allowPaid?: boolean;
}) {
  const outcome = form.watch('outcome');
  const refundReference = form.watch('externalRefundReference') ?? '';
  const refundAddress = usdtReviewRefundAddress(order);
  const totalLine = usdtReviewTotalLine(order);
  const validRefundReference = isUsdtResolutionReferenceInput(refundReference);
  const refundBlocked = outcome === 'refunded' && (refundAddress === null || !validRefundReference);
  const canResolve = !isSubmitting && (allowPaid || outcome !== 'paid') && !refundBlocked;
  return (
    <section
      className="grid gap-3 rounded-md bg-amber-500/5 p-4"
      aria-labelledby="usdt-resolution-title"
      data-testid="seller-usdt-resolution"
    >
      <Typography as="h3" id="usdt-resolution-title" className="font-semibold" data-testid="seller-usdt-resolve-prompt">
        {USDT_PAYMENT_REVIEW_COPY.title}
      </Typography>
      <Typography as="p" className="text-sm text-muted-foreground">
        {USDT_PAYMENT_REVIEW_COPY.intro}
      </Typography>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <ReviewFact label="Manual review entered" value={enteredAt ?? 'Not provided'} />
        <ReviewFact label={USDT_PAYMENT_REVIEW_COPY.amountLabel} value={totalLine} testId="usdt-resolution-total" />
      </dl>
      <label className="grid gap-1 text-sm" htmlFor="usdt-resolution-outcome">
        Outcome
        <Controller
          control={form.control}
          name="outcome"
          render={({ field }) => (
            <select
              {...field}
              id="usdt-resolution-outcome"
              className={`${buttonVariants({ variant: 'secondary' })} w-full`}
            >
              {allowPaid && <option value="paid">{USDT_PAYMENT_REVIEW_COPY.paidOutcome}</option>}
              <option value="refunded">{USDT_PAYMENT_REVIEW_COPY.refundedOutcome}</option>
              <option value="abandoned">{USDT_PAYMENT_REVIEW_COPY.abandonedOutcome}</option>
            </select>
          )}
        />
      </label>
      {outcome === 'refunded' && (
        <div className="grid gap-3" data-testid="usdt-resolution-refund">
          {refundAddress ? (
            <dl className="grid gap-2 text-sm">
              <ReviewFact label={USDT_PAYMENT_REVIEW_COPY.refundAmountLabel} value={totalLine} />
              <ReviewFact
                label={USDT_PAYMENT_REVIEW_COPY.refundAddressLabel}
                value={refundAddress}
                testId="usdt-resolution-address"
                mono
              />
            </dl>
          ) : (
            <Typography
              as="p"
              role="status"
              className="text-sm text-amber-300"
              data-testid="usdt-resolution-no-address"
            >
              {USDT_PAYMENT_REVIEW_COPY.refundAddressMissing}
            </Typography>
          )}
          {refundAddress && (
            <Typography as="p" className="text-sm text-muted-foreground">
              {USDT_PAYMENT_REVIEW_COPY.refundHint}
            </Typography>
          )}
          <Controller
            control={form.control}
            name="externalRefundReference"
            render={({ field }) => (
              <label className="grid gap-1 text-sm" htmlFor="usdt-refund-reference">
                {USDT_PAYMENT_REVIEW_COPY.referenceLabel}
                <Input
                  theme="dashed"
                  {...field}
                  id="usdt-refund-reference"
                  maxLength={66}
                  placeholder="0x…"
                  aria-describedby="usdt-resolution-reference-error usdt-resolution-error"
                  aria-invalid={!validRefundReference}
                  inputMode="text"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            )}
          />
          {!validRefundReference && (
            <Typography
              id="usdt-resolution-reference-error"
              role="alert"
              className="text-sm text-amber-300"
              data-testid="usdt-resolution-reference-error"
            >
              {USDT_PAYMENT_REVIEW_COPY.referenceError}
            </Typography>
          )}
          <Typography as="p" className="text-xs text-muted-foreground" data-testid="usdt-resolution-recorded-note">
            {USDT_PAYMENT_REVIEW_COPY.refundRecordedBySeller}
          </Typography>
        </div>
      )}
      <Controller
        control={form.control}
        name="reason"
        render={({ field, fieldState }) => (
          <label className="grid gap-1 text-sm" htmlFor="usdt-resolution-reason">
            Reason (optional)
            <Input theme="dashed" {...field} id="usdt-resolution-reason" maxLength={500} />
            {fieldState.error && <span className="text-amber-300">{fieldState.error.message}</span>}
          </label>
        )}
      />
      {error && (
        <Typography id="usdt-resolution-error" role="alert" className="text-sm text-amber-300">
          {error}
        </Typography>
      )}
      <Button className="w-fit rounded-full" disabled={!canResolve} onClick={onResolve}>
        {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
        Resolve payment
      </Button>
    </section>
  );
}

function ReviewFact({
  label,
  value,
  testId,
  mono = false,
}: {
  label: string;
  value: string;
  testId?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={mono ? 'font-mono break-all' : 'break-all'}
        data-testid={testId}
        data-sentry-mask={mono || undefined}
      >
        {value}
      </dd>
    </div>
  );
}
