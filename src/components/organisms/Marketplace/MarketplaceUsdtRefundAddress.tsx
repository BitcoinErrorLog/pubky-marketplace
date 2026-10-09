'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Controller, useWatch } from 'react-hook-form';
import { Button } from '@/atoms/Button/Button';
import { Checkbox } from '@/atoms/Checkbox/Checkbox';
import { Heading } from '@/atoms/Heading/Heading';
import { RadioGroup, RadioGroupItem } from '@/atoms/RadioGroup/RadioGroup';
import { Typography } from '@/atoms/Typography/Typography';
import { useConfirmRefundDestination } from '@/hooks/useConfirmRefundDestination/useConfirmRefundDestination';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard/useCopyToClipboard';
import { formatOrderInstant } from '@/libs/commerce/checkout-hold';
import {
  formatUsdtParity,
  isUsdtRefundOrder,
  USDT_REFUND_COPY,
  usdtRefundDueMoney,
  usdtRefundSurface,
} from '@/libs/commerce/usdt-refund';
import { ControlledInputField } from '@/molecules/ControlledInputField/ControlledInputField';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';

const PANEL_CLASSNAME = 'mt-3 grid gap-3 rounded-md border border-border/60 bg-card/50 p-4';

type ActOnOrder = (order: MarketplaceOrder, kind: string, payload: Record<string, unknown>) => Promise<boolean>;

/**
 * The refund address on a USDT order (plan §2.6, W4). The buyer confirms where
 * a refund should go; the seller sees it, sends the refund from Bitkit and
 * records the Arbitrum transaction hash with "Record refund". Everything here
 * is a record of what people said and did: the Shop never moves or checks the
 * money. It renders only for orders projected as paid in USDT, and the
 * new-offer flag does not gate it, so an existing USDT order stays refundable
 * after the flag flips.
 */
export function MarketplaceUsdtRefundAddress({
  order,
  isBuyer,
  paymentInReview,
  actOnOrder,
}: {
  order: MarketplaceOrder;
  isBuyer: boolean;
  /** The payment projection is in `manual_review`: late or mismatched money the seller may return. */
  paymentInReview: boolean;
  actOnOrder: ActOnOrder;
}) {
  const surface = usdtRefundSurface(order, isBuyer, paymentInReview);
  if (surface.kind === 'hidden') return null;
  return surface.kind === 'buyer' ? (
    <BuyerRefundAddress order={order} phase={surface.phase} refundDue={surface.refundDue} actOnOrder={actOnOrder} />
  ) : (
    <SellerRefundAddress order={order} phase={surface.phase} />
  );
}

function AddressLine({ address, confirmedAt }: { address: string; confirmedAt?: string }) {
  const confirmed = formatOrderInstant(confirmedAt);
  return (
    <div className="grid gap-1" data-testid="usdt-refund-destination">
      <Typography as="p" className="font-mono text-sm break-all" data-sentry-mask>
        {address}
      </Typography>
      <Typography as="p" className="text-xs text-muted-foreground">
        USDT on Arbitrum One{confirmed ? ` · confirmed ${confirmed}` : ''}
      </Typography>
    </div>
  );
}

function BuyerRefundAddress({
  order,
  phase,
  refundDue,
  actOnOrder,
}: {
  order: MarketplaceOrder;
  phase: 'needed' | 'confirmed' | 'recorded';
  refundDue: boolean;
  actOnOrder: ActOnOrder;
}) {
  const [editing, setEditing] = useState(false);
  const { form, paymentAddress, submit, reset } = useConfirmRefundDestination(order, actOnOrder);
  const source = useWatch({ control: form.control, name: 'source' });
  const destination = order.refundDestination ?? null;
  const showForm = phase === 'needed' || (phase === 'confirmed' && editing);
  const copy =
    phase === 'recorded'
      ? USDT_REFUND_COPY.buyerRecorded
      : phase === 'confirmed'
        ? USDT_REFUND_COPY.buyerConfirmed
        : refundDue
          ? USDT_REFUND_COPY.buyerNeededDue
          : USDT_REFUND_COPY.buyerNeeded;

  const confirm = async () => {
    if (await submit()) setEditing(false);
  };

  return (
    <section className={PANEL_CLASSNAME} aria-label={USDT_REFUND_COPY.buyerTitle} data-testid="usdt-refund-buyer">
      <Heading level={3} size="sm" className="text-base font-semibold">
        {USDT_REFUND_COPY.buyerTitle}
      </Heading>
      <Typography as="p" className="text-sm text-muted-foreground">
        {copy}
      </Typography>
      {destination && <AddressLine address={destination.address} confirmedAt={destination.confirmedAt} />}
      {phase === 'confirmed' && !editing && (
        <div>
          <Button
            size="sm"
            variant="secondary"
            className="rounded-full"
            onClick={() => {
              reset(destination?.address);
              setEditing(true);
            }}
          >
            Change address
          </Button>
        </div>
      )}
      {showForm && (
        <form
          className="grid gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
        >
          {paymentAddress && (
            <Controller
              name="source"
              control={form.control}
              render={({ field }) => (
                <RadioGroup value={field.value} onValueChange={field.onChange}>
                  <RadioGroupItem
                    value="payment"
                    variant="box"
                    label={USDT_REFUND_COPY.originalAddressChoice}
                    description={paymentAddress}
                  />
                  <RadioGroupItem value="another" variant="box" label={USDT_REFUND_COPY.anotherAddressChoice} />
                </RadioGroup>
              )}
            />
          )}
          {(!paymentAddress || source === 'another') && (
            <ControlledInputField
              name="address"
              control={form.control}
              label="Arbitrum One USDT address"
              placeholder="0x…"
            />
          )}
          <Typography as="p" className="text-xs text-muted-foreground" data-testid="usdt-refund-network-warning">
            {USDT_REFUND_COPY.networkWarning}
          </Typography>
          <Controller
            name="networkConfirmed"
            control={form.control}
            render={({ field, fieldState }) => (
              <div className="grid gap-1">
                <Checkbox
                  checked={field.value}
                  onCheckedChange={(checked) => field.onChange(checked === true)}
                  label={USDT_REFUND_COPY.networkConfirmation}
                />
                {fieldState.error && (
                  <Typography as="p" role="alert" className="text-xs text-destructive">
                    {fieldState.error.message}
                  </Typography>
                )}
              </div>
            )}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" className="rounded-full" disabled={form.formState.isSubmitting}>
              Confirm refund address
            </Button>
            {editing && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="rounded-full"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}

function SellerRefundAddress({
  order,
  phase,
}: {
  order: MarketplaceOrder;
  phase: 'waiting' | 'confirmed' | 'recorded';
}) {
  const [copied, setCopied] = useState(false);
  const { copyToClipboard } = useCopyToClipboard({
    successTitle: 'Refund address copied',
    onSuccess: () => setCopied(true),
  });
  const destination = order.refundDestination ?? null;
  const due = usdtRefundDueMoney(order);
  const dueUsdt = isUsdtRefundOrder(order) ? formatUsdtParity(due) : null;
  const copy =
    phase === 'recorded'
      ? USDT_REFUND_COPY.sellerRecorded
      : phase === 'confirmed'
        ? USDT_REFUND_COPY.sellerConfirmed
        : USDT_REFUND_COPY.sellerAwaitingBuyer;

  return (
    <section className={PANEL_CLASSNAME} aria-label={USDT_REFUND_COPY.sellerTitle} data-testid="usdt-refund-seller">
      <Heading level={3} size="sm" className="text-base font-semibold">
        {USDT_REFUND_COPY.sellerTitle}
      </Heading>
      <Typography as="p" className="text-sm text-muted-foreground">
        {copy}
      </Typography>
      {destination && (
        <>
          <AddressLine address={destination.address} confirmedAt={destination.confirmedAt} />
          {dueUsdt && phase !== 'recorded' && (
            <Typography as="p" className="text-sm" data-testid="usdt-refund-amount">
              Refund amount: {dueUsdt}
            </Typography>
          )}
          <div>
            <Button
              size="sm"
              variant="secondary"
              className="rounded-full"
              onClick={() => void copyToClipboard(destination.address)}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? 'Copied' : 'Copy address'}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
